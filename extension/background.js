// Service worker: owns Firebase Auth (Google sign-in only, via
// chrome.identity) + talks to Firestore's REST API. Content scripts / popup
// never touch tokens directly — they send messages here.
import { FIREBASE_CONFIG } from "./config.js";

const IDENTITY_BASE = "https://identitytoolkit.googleapis.com/v1";
const TOKEN_BASE = "https://securetoken.googleapis.com/v1";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;

// Thrown when a caller asked for a non-interactive auth check and the user
// isn't signed in — distinct from a real network/API failure so message
// handlers can report "not signed in" instead of a hard error.
class SignInRequiredError extends Error {}

async function getAuthState() {
  const { auth } = await chrome.storage.local.get("auth");
  // Anything saved by a pre-Google-sign-in version of the extension has no
  // `provider` field; treat it as absent so we re-authenticate with Google.
  return auth && auth.provider === "google.com" ? auth : null;
}

async function saveAuthState(auth) {
  await chrome.storage.local.set({ auth });
}

function getGoogleAccessToken({ interactive }) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) {
        reject(interactive ? new Error(err?.message || "Google sign-in failed") : new SignInRequiredError());
        return;
      }
      resolve(token);
    });
  });
}

async function signInWithGoogleIdp(accessToken) {
  const res = await fetch(`${IDENTITY_BASE}/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      postBody: `access_token=${accessToken}&providerId=google.com`,
      requestUri: `https://${FIREBASE_CONFIG.projectId}.firebaseapp.com`,
      returnSecureToken: true,
    }),
  });
  if (!res.ok) {
    // A stale/revoked cached Google token is the most likely cause — drop it
    // so the next sign-in attempt fetches a fresh one instead of looping.
    await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token: accessToken }, resolve));
    throw new Error(`Google sign-in failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const auth = {
    uid: data.localId,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn) * 1000,
    provider: "google.com",
    googleAccessToken: accessToken,
  };
  await saveAuthState(auth);
  return auth;
}

async function refreshIdToken(auth) {
  const res = await fetch(`${TOKEN_BASE}/token?key=${FIREBASE_CONFIG.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refreshToken }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const refreshed = {
    uid: data.user_id,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
    provider: "google.com",
    googleAccessToken: auth.googleAccessToken,
  };
  await saveAuthState(refreshed);
  return refreshed;
}

// Returns a valid {uid, idToken}, signing in with Google or refreshing as
// needed. With interactive:false this throws SignInRequiredError instead of
// popping a Google account picker when there's no usable session yet.
async function ensureAuth({ interactive = false } = {}) {
  let auth = await getAuthState();
  if (auth && Date.now() > auth.expiresAt - 60_000) {
    try {
      auth = await refreshIdToken(auth);
    } catch {
      auth = null; // refresh token is dead; fall through to a fresh sign-in
    }
  }
  if (!auth) {
    const accessToken = await getGoogleAccessToken({ interactive });
    auth = await signInWithGoogleIdp(accessToken);
  }
  return auth;
}

async function signOut() {
  const auth = await getAuthState();
  await chrome.storage.local.remove("auth");
  if (auth?.googleAccessToken) {
    await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token: auth.googleAccessToken }, resolve));
  }
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

async function getVideoData(videoId, auth) {
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

async function setVote(videoId, isSlop, videoTitle, auth) {
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
  return getVideoData(videoId, auth);
}

// Records that this viewer watched 60+ seconds of the video without ever
// marking it as slop. Idempotent: writing the same doc again touches no
// count, since the aggregation function only reacts to existence changes.
async function recordTopView(videoId, auth) {
  await firestoreSet(`videos/${videoId}/topViews/${auth.uid}`, { viewedAt: new Date() }, auth.idToken);
  return getVideoData(videoId, auth);
}

async function clearVote(videoId, auth) {
  await firestoreDelete(`videos/${videoId}/votes/${auth.uid}`, auth.idToken);
  return getVideoData(videoId, auth);
}

// Wraps a read that should degrade to "not signed in" rather than error out
// when there's no session yet and we're not allowed to prompt for one.
async function withAuth(interactive, fn) {
  try {
    const auth = await ensureAuth({ interactive });
    return { ok: true, signedIn: true, data: await fn(auth) };
  } catch (err) {
    if (err instanceof SignInRequiredError) return { ok: true, signedIn: false };
    return { ok: false, error: String(err?.message || err) };
  }
}

// Same shape, but a missing session is reported as a write failure — used
// for actions (voting, recording a view) that should never silently no-op.
async function withAuthOrFail(fn) {
  try {
    const auth = await ensureAuth({ interactive: false });
    return { ok: true, signedIn: true, data: await fn(auth) };
  } catch (err) {
    if (err instanceof SignInRequiredError) return { ok: false, error: "SIGN_IN_REQUIRED" };
    return { ok: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "GET_VIDEO_DATA":
          sendResponse(await withAuth(false, (auth) => getVideoData(message.videoId, auth)));
          break;
        case "GET_AUTH_STATE":
          sendResponse(await withAuth(false, () => undefined));
          break;
        case "SIGN_IN":
          sendResponse(
            await withAuth(true, (auth) => (message.videoId ? getVideoData(message.videoId, auth) : undefined))
          );
          break;
        case "SIGN_OUT":
          await signOut();
          sendResponse({ ok: true, signedIn: false });
          break;
        case "SET_VOTE":
          sendResponse(
            await withAuthOrFail((auth) => setVote(message.videoId, message.isSlop, message.videoTitle, auth))
          );
          break;
        case "CLEAR_VOTE":
          sendResponse(await withAuthOrFail((auth) => clearVote(message.videoId, auth)));
          break;
        case "RECORD_TOP_VIEW":
          sendResponse(await withAuthOrFail((auth) => recordTopView(message.videoId, auth)));
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
