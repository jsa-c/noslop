// Service worker: owns Firebase Anonymous Auth + talks to Firestore's REST API.
// Content scripts / popup never touch tokens directly — they send messages here.
import { FIREBASE_CONFIG } from "./config.js";

const IDENTITY_BASE = "https://identitytoolkit.googleapis.com/v1";
const TOKEN_BASE = "https://securetoken.googleapis.com/v1";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;

async function getAuthState() {
  const { auth } = await chrome.storage.local.get("auth");
  return auth || null;
}

async function saveAuthState(auth) {
  await chrome.storage.local.set({ auth });
}

async function signInAnonymously() {
  const res = await fetch(`${IDENTITY_BASE}/accounts:signUp?key=${FIREBASE_CONFIG.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`Anonymous sign-in failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const auth = {
    uid: data.localId,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn) * 1000,
  };
  await saveAuthState(auth);
  return auth;
}

async function refreshIdToken(refreshToken) {
  const res = await fetch(`${TOKEN_BASE}/token?key=${FIREBASE_CONFIG.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const auth = {
    uid: data.user_id,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
  };
  await saveAuthState(auth);
  return auth;
}

// Returns a valid {uid, idToken}, signing in or refreshing as needed.
async function ensureAuth() {
  let auth = await getAuthState();
  if (!auth) {
    auth = await signInAnonymously();
  } else if (Date.now() > auth.expiresAt - 60_000) {
    auth = await refreshIdToken(auth.refreshToken);
  }
  return auth;
}

function fsValue(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "boolean") out[k] = { booleanValue: v };
    else if (typeof v === "number") out[k] = { integerValue: String(v) };
    else if (v instanceof Date) out[k] = { timestampValue: v.toISOString() };
    else out[k] = { stringValue: String(v) };
  }
  return out;
}

function fsParse(fields) {
  const out = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if ("booleanValue" in v) out[k] = v.booleanValue;
    else if ("integerValue" in v) out[k] = Number(v.integerValue);
    else if ("doubleValue" in v) out[k] = v.doubleValue;
    else if ("timestampValue" in v) out[k] = v.timestampValue;
    else if ("stringValue" in v) out[k] = v.stringValue;
  }
  return out;
}

async function firestoreGet(path, idToken) {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET ${path} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return fsParse(data.fields);
}

async function firestoreSet(path, fields, idToken) {
  const mask = Object.keys(fields).map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
  const res = await fetch(`${FIRESTORE_BASE}/${path}?${mask}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields: fsValue(fields) }),
  });
  if (!res.ok) throw new Error(`Firestore PATCH ${path} failed: ${res.status} ${await res.text()}`);
}

async function firestoreDelete(path, idToken) {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Firestore DELETE ${path} failed: ${res.status} ${await res.text()}`);
  }
}

async function getVideoData(videoId) {
  const auth = await ensureAuth();
  const [stats, myVote] = await Promise.all([
    firestoreGet(`videos/${videoId}`, auth.idToken),
    firestoreGet(`videos/${videoId}/votes/${auth.uid}`, auth.idToken),
  ]);
  return {
    stats: {
      slopCount: stats?.slopCount ?? 0,
      totalVotes: stats?.totalVotes ?? 0,
      topScore: stats?.topScore ?? 0,
    },
    myVote: myVote ? myVote.isSlop : null,
  };
}

async function setVote(videoId, isSlop, videoTitle) {
  const auth = await ensureAuth();
  await firestoreSet(
    `videos/${videoId}/votes/${auth.uid}`,
    { isSlop, votedAt: new Date(), videoTitle: videoTitle || "" },
    auth.idToken
  );
  if (isSlop) {
    // Marking a video as slop revokes any top-view credit this viewer
    // already earned for it — the badge is only for videos never marked slop.
    await firestoreDelete(`videos/${videoId}/topViews/${auth.uid}`, auth.idToken);
  }
  return getVideoData(videoId);
}

// Records that this viewer watched 60+ seconds of the video without ever
// marking it as slop. Idempotent: writing the same doc again touches no
// count, since the aggregation function only reacts to existence changes.
async function recordTopView(videoId) {
  const auth = await ensureAuth();
  await firestoreSet(`videos/${videoId}/topViews/${auth.uid}`, { viewedAt: new Date() }, auth.idToken);
  return getVideoData(videoId);
}

async function clearVote(videoId) {
  const auth = await ensureAuth();
  await firestoreDelete(`videos/${videoId}/votes/${auth.uid}`, auth.idToken);
  return getVideoData(videoId);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "GET_VIDEO_DATA":
          sendResponse({ ok: true, data: await getVideoData(message.videoId) });
          break;
        case "SET_VOTE":
          sendResponse({ ok: true, data: await setVote(message.videoId, message.isSlop, message.videoTitle) });
          break;
        case "CLEAR_VOTE":
          sendResponse({ ok: true, data: await clearVote(message.videoId) });
          break;
        case "RECORD_TOP_VIEW":
          sendResponse({ ok: true, data: await recordTopView(message.videoId) });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
