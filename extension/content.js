// Injects a small floating widget on YouTube watch pages that lets users
// mark/unmark the current video as "slop" and shows the community count.
// Deliberately floats independently of YouTube's DOM (rather than being
// inserted next to like/dislike) so it keeps working when YouTube reshuffles
// its internal class names. A Slop / Not Slop button pair is *also* injected
// next to the like/dislike row for people who'd rather vote there; that one
// does depend on YouTube's DOM, so it degrades to simply not appearing if it
// can't find an anchor.

const WIDGET_ID = "noslop-widget";
const INLINE_ID = "noslop-inline";
const TOAST_ID = "noslop-toast";

let currentVideoId = null;
// This viewer's vote on the current video (true = slop, false = not slop,
// null = no vote). Shared so the widget toggle and the inline buttons always
// render the same state instead of each tracking their own copy.
let currentMyVote = null;

// Community slop score is slopCount / totalVotes (0..1). At the threshold
// below, a video where every voter agrees it's slop gets auto-skipped.
const AUTO_SKIP_SLOP_SCORE_THRESHOLD = 1;

// Watching this many seconds without ever marking the video as slop earns
// it one unique-viewer "top" point (videos/{videoId}.topScore).
const TOP_VIEW_WATCH_SECONDS_THRESHOLD = 60;

// Grace period before an auto-skip actually fires. The video keeps playing
// where it is while the toast counts this down, so the viewer can call the
// skip off. Kept short — it's time spent watching a video we believe is slop.
const AUTO_SKIP_COUNTDOWN_SECONDS = 2;

// An auto-skip stops this far short of the end rather than seeking exactly to
// `duration`, which can leave the player parked on the final frame instead of
// handing off to YouTube's "up next" autoplay.
const AUTO_SKIP_END_MARGIN_SECONDS = 1;

let watchState = null; // { videoId, video, listener, watchedSeconds, lastTime, myVote, recorded }
let inlineRetryTimer = null;

// Live auto-skip countdown: { videoId, video, raf, remaining, lastFrame, bar, label }.
let countdown = null;
// Set when the viewer hits "Keep watching", so re-renders (e.g. after voting)
// don't immediately restart the skip. Reset on every navigation.
let skipCancelled = false;
// Most recent payload for the current video, so cancelling can restore the
// widget to its normal (non-skipping) rendering.
let lastVideoData = null;

function getVideoId() {
  const params = new URLSearchParams(location.search);
  return params.get("v");
}

function getVideoTitle() {
  return document.title.replace(/ - YouTube$/, "");
}

function ensureWidget() {
  let widget = document.getElementById(WIDGET_ID);
  if (widget) return widget;

  widget = document.createElement("div");
  widget.id = WIDGET_ID;
  widget.innerHTML = `
    <div class="noslop-header">
      <span class="noslop-title">NonSlop</span>
      <button class="noslop-collapse" title="Minimize" aria-label="Minimize">–</button>
    </div>
    <div class="noslop-body">
      <div class="noslop-count">Loading…</div>
      <div class="noslop-top"></div>
      <button class="noslop-toggle" disabled>Mark as Slop</button>
    </div>
  `;
  document.body.appendChild(widget);

  widget.querySelector(".noslop-collapse").addEventListener("click", () => {
    widget.classList.toggle("noslop-collapsed");
  });

  widget.querySelector(".noslop-toggle").addEventListener("click", () => {
    const videoId = getVideoId();
    if (videoId) castVote(videoId, true);
  });

  return widget;
}

function getSlopScore(stats) {
  return stats.totalVotes > 0 ? stats.slopCount / stats.totalVotes : 0;
}

async function isAutoSkipEnabled() {
  const { autoSkipEnabled } = await chrome.storage.sync.get({ autoSkipEnabled: false });
  return autoSkipEnabled;
}

function ensureToast() {
  let toast = document.getElementById(TOAST_ID);
  if (toast) return toast;

  toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.setAttribute("role", "status");
  toast.innerHTML = `
    <div class="noslop-toast-row">
      <span class="noslop-toast-text"></span>
      <button type="button" class="noslop-toast-cancel">Keep watching</button>
    </div>
    <div class="noslop-toast-track"><div class="noslop-toast-bar"></div></div>
  `;
  toast.querySelector(".noslop-toast-cancel").addEventListener("click", cancelSkip);
  document.body.appendChild(toast);
  return toast;
}

function hideToast() {
  document.getElementById(TOAST_ID)?.classList.remove("noslop-toast-visible");
}

function stopCountdown() {
  if (!countdown) return;
  cancelAnimationFrame(countdown.raf);
  countdown = null;
}

// Warn before skipping rather than yanking the video away. The video keeps
// playing where it is; the toast counts down AUTO_SKIP_COUNTDOWN_SECONDS and
// offers a way out. If the viewer does nothing, performSkip() runs.
function beginSkipCountdown(videoId, stats) {
  const video = document.querySelector("video");
  if (!video) return;
  // Already counting down for this video — leave it alone rather than
  // restarting (and so extending) the grace period. Voting mid-countdown
  // re-enters here via applyVideoData().
  if (countdown?.videoId === videoId) return;

  const toast = ensureToast();
  const pct = stats.totalVotes > 0 ? Math.round((stats.slopCount / stats.totalVotes) * 100) : 0;
  toast.querySelector(".noslop-toast-text").textContent =
    `🗑️ This video is sloppy — ${pct}% of ${stats.totalVotes} votes say slop.`;

  // Re-trigger the entrance transition even if a toast is already showing.
  toast.classList.remove("noslop-toast-visible");
  void toast.offsetWidth;
  toast.classList.add("noslop-toast-visible");

  stopCountdown();
  countdown = {
    videoId,
    video,
    raf: 0,
    remaining: AUTO_SKIP_COUNTDOWN_SECONDS,
    lastFrame: performance.now(),
    bar: toast.querySelector(".noslop-toast-bar"),
    label: toast.querySelector(".noslop-toast-cancel"),
  };
  renderCountdown();
  countdown.raf = requestAnimationFrame(tickCountdown);
}

function renderCountdown() {
  const { remaining, bar, label } = countdown;
  bar.style.width = `${Math.max(0, Math.min(1, remaining / AUTO_SKIP_COUNTDOWN_SECONDS)) * 100}%`;
  label.textContent = `Keep watching (${Math.max(0, Math.ceil(remaining))}s)`;
}

// Wall-clock countdown, but frozen while the video is paused: a paused video
// isn't slop anyone is sitting through, so there's nothing to rescue them
// from until playback resumes.
function tickCountdown(now) {
  if (!countdown || countdown.videoId !== currentVideoId) return;

  const elapsed = (now - countdown.lastFrame) / 1000;
  countdown.lastFrame = now;
  if (!countdown.video.paused) countdown.remaining -= elapsed;

  renderCountdown();

  if (countdown.remaining > 0) {
    countdown.raf = requestAnimationFrame(tickCountdown);
  } else {
    performSkip();
  }
}

// Jump to just short of the end so the video finishes and YouTube's "up
// next" autoplay moves on.
function performSkip() {
  const { video } = countdown;
  stopCountdown();
  hideToast();

  const jumpNearEnd = () => {
    if (!isFinite(video.duration)) return;
    video.currentTime = Math.max(0, video.duration - AUTO_SKIP_END_MARGIN_SECONDS);
  };
  if (video.readyState >= 1 && isFinite(video.duration)) jumpNearEnd();
  else video.addEventListener("loadedmetadata", jumpNearEnd, { once: true });
}

// "Keep watching": call the skip off and don't re-arm it for this video. The
// playhead never moved, so there's nothing to restore.
function cancelSkip() {
  if (!countdown) return;

  skipCancelled = true;
  stopCountdown();
  hideToast();

  if (lastVideoData && currentVideoId) {
    render(ensureWidget(), lastVideoData, currentVideoId);
  }
}

// YouTube's like/dislike markup has been reshuffled more than once, so try a
// few known anchors and give up quietly rather than breaking the page.
function findActionsBar() {
  const selectors = [
    "ytd-watch-metadata #top-level-buttons-computed",
    "#actions-inner #top-level-buttons-computed",
    "ytd-menu-renderer #top-level-buttons-computed",
    "#top-level-buttons-computed",
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function buildInlineGroup() {
  const group = document.createElement("div");
  group.id = INLINE_ID;
  group.innerHTML = `
    <button type="button" class="noslop-inline-btn noslop-inline-slop">🗑️ Slop</button>
    <button type="button" class="noslop-inline-btn noslop-inline-noslop">✓ Not Slop</button>
  `;
  group.querySelector(".noslop-inline-slop").addEventListener("click", () => {
    const videoId = getVideoId();
    if (videoId) castVote(videoId, true);
  });
  group.querySelector(".noslop-inline-noslop").addEventListener("click", () => {
    const videoId = getVideoId();
    if (videoId) castVote(videoId, false);
  });
  return group;
}

// Retries for a few seconds because the actions bar usually isn't in the DOM
// yet right after a YouTube SPA navigation.
function ensureInlineButtons(videoId) {
  clearTimeout(inlineRetryTimer);
  document.getElementById(INLINE_ID)?.remove();

  const attempt = (attemptsLeft) => {
    if (videoId !== currentVideoId || document.getElementById(INLINE_ID)) return;
    const bar = findActionsBar();
    if (!bar) {
      if (attemptsLeft > 0) inlineRetryTimer = setTimeout(() => attempt(attemptsLeft - 1), 500);
      return;
    }
    bar.insertAdjacentElement("afterend", buildInlineGroup());
    renderInlineButtons();
  };

  attempt(10);
}

function renderInlineButtons() {
  const group = document.getElementById(INLINE_ID);
  if (!group) return;
  group
    .querySelector(".noslop-inline-slop")
    .classList.toggle("noslop-inline-active", currentMyVote === true);
  group
    .querySelector(".noslop-inline-noslop")
    .classList.toggle("noslop-inline-active", currentMyVote === false);
}

function disableVoteControls(disabled) {
  const toggleEl = document.getElementById(WIDGET_ID)?.querySelector(".noslop-toggle");
  if (toggleEl) toggleEl.disabled = disabled;
  document
    .getElementById(INLINE_ID)
    ?.querySelectorAll(".noslop-inline-btn")
    .forEach((btn) => (btn.disabled = disabled));
}

// Accumulates real playback time (ignoring seeks/jumps) and, once it
// crosses the threshold, records a unique top view — unless this viewer has
// marked the video as slop in the meantime.
function onWatchTimeUpdate(state) {
  if (state.recorded || state.myVote === true) return;

  const t = state.video.currentTime;
  const delta = t - state.lastTime;
  if (delta > 0 && delta < 1.5) state.watchedSeconds += delta;
  state.lastTime = t;

  if (state.watchedSeconds >= TOP_VIEW_WATCH_SECONDS_THRESHOLD) {
    state.recorded = true;
    chrome.runtime.sendMessage({ type: "RECORD_TOP_VIEW", videoId: state.videoId });
  }
}

function resetWatchTracking(videoId, myVote) {
  if (watchState) {
    watchState.video.removeEventListener("timeupdate", watchState.listener);
    watchState = null;
  }

  const video = document.querySelector("video");
  if (!video) return;

  const state = { videoId, video, watchedSeconds: 0, lastTime: video.currentTime, myVote, recorded: false };
  state.listener = () => onWatchTimeUpdate(state);
  video.addEventListener("timeupdate", state.listener);
  watchState = state;
}

function render(widget, { stats, myVote }, videoId, { skipping = false } = {}) {
  if (videoId !== currentVideoId) return; // stale response from a previous video
  const countEl = widget.querySelector(".noslop-count");
  const topEl = widget.querySelector(".noslop-top");
  const toggleEl = widget.querySelector(".noslop-toggle");

  const pct = stats.totalVotes > 0 ? Math.round((stats.slopCount / stats.totalVotes) * 100) : 0;
  countEl.textContent = skipping
    ? `⏭️ Skipping — ${pct}% of ${stats.totalVotes} votes say slop`
    : stats.totalVotes > 0
      ? `🗑️ ${stats.slopCount}/${stats.totalVotes} votes say slop (${pct}%)`
      : "No votes yet — be the first";

  topEl.textContent = stats.topScore > 0 ? `⭐ ${stats.topScore} watched it through, unflagged` : "";

  toggleEl.disabled = false;
  if (myVote === true) {
    toggleEl.textContent = "✓ Marked as Slop";
    toggleEl.classList.add("noslop-active");
  } else {
    toggleEl.textContent = "Mark as Slop";
    toggleEl.classList.remove("noslop-active");
  }
}

// Applies a fresh GET_VIDEO_DATA / SET_VOTE / CLEAR_VOTE response: updates
// the shared vote state, runs the auto-skip check, and re-renders every
// surface. `freshLoad` distinguishes a brand-new video (reset watch-time
// tracking) from a vote cast mid-viewing (just patch the myVote snapshot, so
// voting doesn't zero out progress toward the top-score threshold).
async function applyVideoData(widget, videoId, data, { freshLoad = false } = {}) {
  currentMyVote = data.myVote;
  lastVideoData = data;

  const shouldSkip =
    !skipCancelled &&
    getSlopScore(data.stats) >= AUTO_SKIP_SLOP_SCORE_THRESHOLD &&
    (await isAutoSkipEnabled());
  if (videoId !== currentVideoId) return;

  if (shouldSkip) {
    // Watch-time tracking still resets, so cancelling mid-countdown leaves a
    // sane baseline for the top-score threshold.
    if (freshLoad) resetWatchTracking(videoId, data.myVote);
    beginSkipCountdown(videoId, data.stats);
    render(widget, data, videoId, { skipping: true });
  } else {
    if (freshLoad) resetWatchTracking(videoId, data.myVote);
    else if (watchState?.videoId === videoId) watchState.myVote = data.myVote;
    render(widget, data, videoId);
  }

  renderInlineButtons();
  disableVoteControls(false);
}

// Clicking the button matching your existing vote clears it; anything else
// sets it. Drives both the widget toggle and the inline Slop/Not Slop pair.
async function castVote(videoId, desiredIsSlop) {
  const message =
    currentMyVote === desiredIsSlop
      ? { type: "CLEAR_VOTE", videoId }
      : { type: "SET_VOTE", videoId, isSlop: desiredIsSlop, videoTitle: getVideoTitle() };

  disableVoteControls(true);
  const res = await chrome.runtime.sendMessage(message);
  if (videoId !== currentVideoId) return;

  if (res?.ok) {
    await applyVideoData(ensureWidget(), videoId, res.data);
  } else {
    disableVoteControls(false);
  }
}

async function loadForCurrentVideo() {
  const videoId = getVideoId();
  currentVideoId = videoId;
  currentMyVote = null;
  lastVideoData = null;
  skipCancelled = false;
  stopCountdown();
  hideToast();
  if (!videoId) return;

  const widget = ensureWidget();
  widget.querySelector(".noslop-count").textContent = "Loading…";
  widget.querySelector(".noslop-toggle").disabled = true;
  ensureInlineButtons(videoId);

  const res = await chrome.runtime.sendMessage({ type: "GET_VIDEO_DATA", videoId });
  if (videoId !== currentVideoId) return; // navigated away while loading

  if (!res?.ok) {
    widget.querySelector(".noslop-count").textContent = "Couldn't load NonSlop data";
    return;
  }

  await applyVideoData(widget, videoId, res.data, { freshLoad: true });
}

// YouTube is a SPA: it fires yt-navigate-finish on client-side route changes
// instead of a full page load.
document.addEventListener("yt-navigate-finish", loadForCurrentVideo);
loadForCurrentVideo();
