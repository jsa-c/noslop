// Injects a small floating widget on YouTube watch pages that lets users
// mark/unmark the current video as "slop" and shows the community count.
// Deliberately floats independently of YouTube's DOM (rather than being
// inserted next to like/dislike) so it keeps working when YouTube reshuffles
// its internal class names.

const WIDGET_ID = "noslop-widget";
let currentVideoId = null;

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
      <span class="noslop-title">NoSlop</span>
      <button class="noslop-collapse" title="Minimize" aria-label="Minimize">–</button>
    </div>
    <div class="noslop-body">
      <div class="noslop-count">Loading…</div>
      <button class="noslop-toggle" disabled>Mark as Slop</button>
    </div>
  `;
  document.body.appendChild(widget);

  widget.querySelector(".noslop-collapse").addEventListener("click", () => {
    widget.classList.toggle("noslop-collapsed");
  });

  widget.querySelector(".noslop-toggle").addEventListener("click", onToggleClick);

  return widget;
}

function render(widget, { stats, myVote }, videoId) {
  if (videoId !== currentVideoId) return; // stale response from a previous video
  const countEl = widget.querySelector(".noslop-count");
  const toggleEl = widget.querySelector(".noslop-toggle");

  const pct = stats.totalVotes > 0 ? Math.round((stats.slopCount / stats.totalVotes) * 100) : 0;
  countEl.textContent =
    stats.totalVotes > 0
      ? `🗑️ ${stats.slopCount}/${stats.totalVotes} votes say slop (${pct}%)`
      : "No votes yet — be the first";

  toggleEl.disabled = false;
  if (myVote === true) {
    toggleEl.textContent = "✓ Marked as Slop";
    toggleEl.classList.add("noslop-active");
  } else {
    toggleEl.textContent = "Mark as Slop";
    toggleEl.classList.remove("noslop-active");
  }
}

async function loadForCurrentVideo() {
  const videoId = getVideoId();
  currentVideoId = videoId;
  if (!videoId) return;

  const widget = ensureWidget();
  widget.querySelector(".noslop-count").textContent = "Loading…";
  widget.querySelector(".noslop-toggle").disabled = true;

  const res = await chrome.runtime.sendMessage({ type: "GET_VIDEO_DATA", videoId });
  if (!res?.ok) {
    widget.querySelector(".noslop-count").textContent = "Couldn't load NoSlop data";
    return;
  }
  render(widget, res.data, videoId);
}

async function onToggleClick(event) {
  const videoId = getVideoId();
  if (!videoId) return;
  const widget = event.target.closest(`#${WIDGET_ID}`);
  const toggleEl = widget.querySelector(".noslop-toggle");
  const currentlyMarked = toggleEl.classList.contains("noslop-active");

  toggleEl.disabled = true;
  const message = currentlyMarked
    ? { type: "CLEAR_VOTE", videoId }
    : { type: "SET_VOTE", videoId, isSlop: true, videoTitle: getVideoTitle() };

  const res = await chrome.runtime.sendMessage(message);
  if (res?.ok) {
    render(widget, res.data, videoId);
  } else {
    toggleEl.disabled = false;
  }
}

// YouTube is a SPA: it fires yt-navigate-finish on client-side route changes
// instead of a full page load.
document.addEventListener("yt-navigate-finish", loadForCurrentVideo);
loadForCurrentVideo();
