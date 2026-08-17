const content = document.getElementById("content");

function getVideoIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "www.youtube.com" && u.pathname === "/watch") {
      return u.searchParams.get("v");
    }
  } catch {
    // not a valid URL
  }
  return null;
}

function renderNoVideo() {
  content.innerHTML = `<p id="status">Open a YouTube video to mark it as slop.</p>`;
}

function renderVideo(videoId, videoTitle, { stats, myVote }) {
  const pct = stats.totalVotes > 0 ? Math.round((stats.slopCount / stats.totalVotes) * 100) : 0;
  content.innerHTML = `
    <p class="video-title">${videoTitle}</p>
    <p class="count">${
      stats.totalVotes > 0
        ? `🗑️ ${stats.slopCount}/${stats.totalVotes} votes say slop (${pct}%)`
        : "No votes yet — be the first"
    }</p>
    ${stats.topScore > 0 ? `<p class="top">⭐ ${stats.topScore} watched it through, unflagged</p>` : ""}
    <button id="toggle" class="${myVote ? "active" : ""}">${myVote ? "✓ Marked as Slop" : "Mark as Slop"}</button>
  `;

  document.getElementById("toggle").addEventListener("click", async (e) => {
    e.target.disabled = true;
    const message = myVote
      ? { type: "CLEAR_VOTE", videoId }
      : { type: "SET_VOTE", videoId, isSlop: true, videoTitle };
    const res = await chrome.runtime.sendMessage(message);
    if (res?.ok) {
      renderVideo(videoId, videoTitle, res.data);
    } else {
      e.target.disabled = false;
    }
  });
}

async function initSettings() {
  const toggle = document.getElementById("auto-skip-toggle");
  const { autoSkipEnabled } = await chrome.storage.sync.get({ autoSkipEnabled: false });
  toggle.checked = autoSkipEnabled;

  toggle.addEventListener("change", () => {
    chrome.storage.sync.set({ autoSkipEnabled: toggle.checked });
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = tab?.url ? getVideoIdFromUrl(tab.url) : null;

  if (!videoId) {
    renderNoVideo();
    return;
  }

  const videoTitle = (tab.title || "").replace(/ - YouTube$/, "");
  const res = await chrome.runtime.sendMessage({ type: "GET_VIDEO_DATA", videoId });
  if (!res?.ok) {
    content.innerHTML = `<p id="status">Couldn't load NonSlop data. Is the extension configured? See README.</p>`;
    return;
  }
  renderVideo(videoId, videoTitle, res.data);
}

init();
initSettings();
