// Injects a small floating widget on YouTube watch pages that lets users
// mark/unmark the current video as "slop" and shows the community count.
// Deliberately floats independently of YouTube's DOM (rather than being
// inserted next to like/dislike) so it keeps working when YouTube reshuffles
// its internal class names. A second, smaller pair of buttons is also
// injected next to the like/dislike row for people who'd rather vote there;
// that one does depend on YouTube's DOM and degrades gracefully if it can't
// find an anchor.

const WIDGET_ID = "noslop-widget";
const INLINE_ID = "noslop-inline";
const TOAST_ID = "noslop-toast";

let currentVideoId = null;
// Mirrors the signed-in user's vote on the current video (true/false/null)
// and whether they're signed in at all — both the widget and the inline
// buttons render off these instead of tracking their own copies.
let currentSignedIn = false;
let currentMyVote = null;

// Community slop score is slopCount / totalVotes (0..1). At the threshold
// below, a video where every voter agrees it's slop gets auto-skipped.
const AUTO_SKIP_SLOP_SCORE_THRESHOLD = 1;

// Watching this many seconds without ever marking the video as slop earns
// it one unique-viewer "top" point (videos/{videoId}.topScore).
const TOP_VIEW_WATCH_SECONDS_THRESHOLD = 60;

let watchState = null; // { videoId, video, listener, watchedSeconds, lastTime, myVote, recorded }
let inlineRetryTimer = null;
let toastHideTimer = null;

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
      <button class="noslop-signin" type="button" hidden>Sign in with Google</button>
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
  widget.querySelector(".noslop-signin").addEventListener("click", onSignInClick);

  return widget;
}

function getSlopScore(stats) {
  return stats.totalVotes > 0 ? stats.slopCount / stats.totalVotes : 0;
}

async function isAutoSkipEnabled() {
  const { autoSkipEnabled } = await chrome.storage.sync.get({ autoSkipEnabled: false });
  return autoSkipEnabled;
}

// Jumps to one second before the end so YouTube's own "up next" handling
// takes over almost immediately, rather than trying to drive YouTube's
// next-video button directly. Landing exactly on `duration` can leave the
// player paused on the last frame instead of advancing.
function skipVideo() {
  const video = document.querySelector("video");
  if (!video) return;
  const jumpNearEnd = () => {
    video.currentTime = Math.max(0, video.duration - 1);
  };
  if (video.readyState >= 1 && isFinite(video.duration)) {
    jumpNearEnd();
  } else {
    video.addEventListener("loadedmetadata", jumpNearEnd, { once: true });
  }
}

function showSkipToast(stats) {
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement("div");
    toast.id = TOAST_ID;
    document.body.appendChild(toast);
  }

  const pct = stats.totalVotes > 0 ? Math.round((stats.slopCount / stats.totalVotes) * 100) : 0;
  toast.textContent = `🗑️ This video is sloppy (${pct}% of ${stats.totalVotes} votes say slop) — skipping…`;

  // Re-trigger the show animation even if a toast is already visible.
  toast.classList.remove("noslop-toast-visible");
  void toast.offsetWidth;
  toast.classList.add("noslop-toast-visible");

  clearTimeout(toastHideTimer);
  toastHideTimer = setTimeout(() => toast.classList.remove("noslop-toast-visible"), 5000);
}

// YouTube's like/dislike markup has changed shape more than once; try a few
// selectors and give up quietly if none match rather than breaking the page.
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
    <button type="button" class="noslop-inline-btn noslop-inline-signin" hidden>Sign in to rate</button>
  `;
  group.querySelector(".noslop-inline-slop").addEventListener("click", () => {
    const videoId = getVideoId();
    if (videoId) castVote(videoId, true);
  });
  group.querySelector(".noslop-inline-noslop").addEventListener("click", () => {
    const videoId = getVideoId();
    if (videoId) castVote(videoId, false);
  });
  group.querySelector(".noslop-inline-signin").addEventListener("click", onSignInClick);
  return group;
}

// Retries because the actions bar often isn't in the DOM yet right after a
// YouTube SPA navigation. Cheap to keep the group's own state in sync with
// the module-level vote/sign-in state via renderInlineButtons() once found.
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
  const slopBtn = group.querySelector(".noslop-inline-slop");
  const noSlopBtn = group.querySelector(".noslop-inline-noslop");
  const signinBtn = group.querySelector(".noslop-inline-signin");

  if (!currentSignedIn) {
    slopBtn.hidden = true;
    noSlopBtn.hidden = true;
    signinBtn.hidden = false;
    return;
  }

  slopBtn.hidden = false;
  noSlopBtn.hidden = false;
  signinBtn.hidden = true;
  slopBtn.classList.toggle("noslop-inline-active", currentMyVote === true);
  noSlopBtn.classList.toggle("noslop-inline-active", currentMyVote === false);
}

function disableVoteControls(disabled) {
  const toggleEl = document.getElementById(WIDGET_ID)?.querySelector(".noslop-toggle");
  if (toggleEl) toggleEl.disabled = disabled;
  document.getElementById(INLINE_ID)
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

function renderLoading(widget) {
  widget.querySelector(".noslop-count").textContent = "Loading…";
  widget.querySelector(".noslop-top").textContent = "";
  widget.querySelector(".noslop-toggle").hidden = false;
  widget.querySelector(".noslop-toggle").disabled = true;
  widget.querySelector(".noslop-signin").hidden = true;
}

function renderSignedOut(widget) {
  currentSignedIn = false;
  currentMyVote = null;

  widget.querySelector(".noslop-count").textContent = "Sign in with Google to see and flag slop.";
  widget.querySelector(".noslop-top").textContent = "";
  widget.querySelector(".noslop-toggle").hidden = true;

  const signinBtn = widget.querySelector(".noslop-signin");
  signinBtn.hidden = false;
  signinBtn.disabled = false;
  signinBtn.textContent = "Sign in with Google";

  renderInlineButtons();
}

function render(widget, { stats, myVote }, videoId, { skipped = false } = {}) {
  if (videoId !== currentVideoId) return; // stale response from a previous video
  const countEl = widget.querySelector(".noslop-count");
  const topEl = widget.querySelector(".noslop-top");
  const toggleEl = widget.querySelector(".noslop-toggle");

  widget.querySelector(".noslop-signin").hidden = true;
  toggleEl.hidden = false;

  const pct = stats.totalVotes > 0 ? Math.round((stats.slopCount / stats.totalVotes) * 100) : 0;
  countEl.textContent = skipped
    ? `⏭️ Auto-skipped — ${pct}% of ${stats.totalVotes} votes say slop`
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

// Applies a fresh GET_VIDEO_DATA/SET_VOTE/etc response: updates the shared
// vote state, runs the auto-skip check, and re-renders every surface.
// `freshLoad` gates whether watch-time tracking resets (a brand-new video)
// or just has its myVote snapshot patched (a vote cast mid-viewing
// shouldn't zero out progress toward the top-score threshold).
async function applyVideoData(widget, videoId, data, { freshLoad = false } = {}) {
  currentSignedIn = true;
  currentMyVote = data.myVote;

  const shouldSkip = getSlopScore(data.stats) >= AUTO_SKIP_SLOP_SCORE_THRESHOLD && (await isAutoSkipEnabled());
  if (shouldSkip) {
    skipVideo();
    showSkipToast(data.stats);
    render(widget, data, videoId, { skipped: true });
  } else {
    if (freshLoad) resetWatchTracking(videoId, data.myVote);
    else if (watchState?.videoId === videoId) watchState.myVote = data.myVote;
    render(widget, data, videoId);
  }

  renderInlineButtons();
  disableVoteControls(false);
}

async function castVote(videoId, desiredIsSlop) {
  const isSameVote = currentMyVote === desiredIsSlop;
  const message = isSameVote
    ? { type: "CLEAR_VOTE", videoId }
    : { type: "SET_VOTE", videoId, isSlop: desiredIsSlop, videoTitle: getVideoTitle() };

  disableVoteControls(true);
  const res = await chrome.runtime.sendMessage(message);
  if (videoId !== currentVideoId) return;

  if (res?.ok && res.signedIn) {
    await applyVideoData(ensureWidget(), videoId, res.data);
    return;
  }

  disableVoteControls(false);
  if (res?.error === "SIGN_IN_REQUIRED") {
    renderSignedOut(ensureWidget());
  }
}

async function onSignInClick() {
  const videoId = getVideoId();
  if (!videoId) return;

  const widget = ensureWidget();
  const signinButtons = [
    widget.querySelector(".noslop-signin"),
    document.querySelector(`#${INLINE_ID} .noslop-inline-signin`),
  ].filter(Boolean);
  signinButtons.forEach((btn) => {
    btn.disabled = true;
    btn.textContent = "Signing in…";
  });

  const res = await chrome.runtime.sendMessage({ type: "SIGN_IN", videoId });
  if (videoId !== currentVideoId) return;

  if (res?.ok && res.signedIn && res.data) {
    await applyVideoData(widget, videoId, res.data, { freshLoad: true });
    return;
  }

  signinButtons.forEach((btn) => {
    btn.disabled = false;
    btn.textContent = btn.classList.contains("noslop-inline-signin") ? "Sign in to rate" : "Sign in with Google";
  });
}

async function loadForCurrentVideo() {
  const videoId = getVideoId();
  currentVideoId = videoId;
  if (!videoId) return;

  const widget = ensureWidget();
  renderLoading(widget);
  ensureInlineButtons(videoId);

  const res = await chrome.runtime.sendMessage({ type: "GET_VIDEO_DATA", videoId });
  if (videoId !== currentVideoId) return; // navigated away while loading

  if (!res?.ok) {
    widget.querySelector(".noslop-count").textContent = "Couldn't load NonSlop data";
    return;
  }

  if (!res.signedIn) {
    renderSignedOut(widget);
    return;
  }

  await applyVideoData(widget, videoId, res.data, { freshLoad: true });
}

// YouTube is a SPA: it fires yt-navigate-finish on client-side route changes
// instead of a full page load.
document.addEventListener("yt-navigate-finish", loadForCurrentVideo);
loadForCurrentVideo();
