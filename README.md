# NonSlop

A Chrome extension that lets users flag YouTube videos as **slop**
(low-effort / AI-generated content) and see how many other users agree.
Votes are backed by Firebase (Firestore + a Cloud Function that keeps the
public counts in sync).

```
extension/   Chrome MV3 extension (content script, popup, background worker)
firebase/    Firestore rules + a Cloud Function for vote aggregation
```

## How it works

- Each anonymous user (via Firebase Anonymous Auth) can cast one vote per
  video: `videos/{videoId}/votes/{uid}` → `{ isSlop: true }`.
- Users can only read/write their own vote document — enforced by
  `firebase/firestore.rules`.
- A Cloud Function (`firebase/functions/index.js`) listens for vote writes
  and recomputes `videos/{videoId}.slopCount` / `.totalVotes`. Clients can
  only *read* that aggregate doc, never write it, so nobody can fake the
  public score.
- The extension talks to Firebase over its plain REST APIs (Identity
  Toolkit + Firestore) from the background service worker — no bundler
  required, and the Web API key is safe to ship since it doesn't grant any
  access on its own (the security rules do that).
- Optional **auto-skip**: toggle "Auto-skip videos with a high slop score"
  in the popup and the content script will jump to the end of any video
  whose slop score (`slopCount / totalVotes`) meets the threshold hardcoded
  in `extension/content.js` (`AUTO_SKIP_SLOP_SCORE_THRESHOLD`, currently
  `1` — unanimous votes only). The setting is stored in `chrome.storage.sync`.
- **Top score**: the content script tracks real playback time (ignoring
  seeks), and once a viewer has watched 60+ seconds of a video without ever
  marking it as slop, it writes `videos/{videoId}/topViews/{uid}` — one doc
  per unique viewer. A second Cloud Function aggregates those into
  `videos/{videoId}.topScore`, the same read-only/write-via-function pattern
  as `slopCount`. Marking a video as slop afterwards deletes that viewer's
  top-view doc, revoking the point.

## Versioning

`extension/manifest.json` and both `firebase/package.json` /
`firebase/functions/package.json` are kept on the same version number, since
a frontend release can depend on that version's Firestore rules/Cloud
Functions being deployed. Bump all three together when either side changes.

## 1. Set up the Firebase project

1. Create a project at https://console.firebase.google.com.
2. **Build → Authentication → Sign-in method** → enable **Anonymous**.
3. **Build → Firestore Database** → create a database (production mode is
   fine; the rules below control access).
4. **Project settings → General → Your apps** → add a **Web app** and copy
   its `apiKey` and `projectId`.

## 2. Deploy the backend

`firebase-tools` is a local dev dependency of `firebase/`, so no global
install is needed — everything runs through `npm run` via `npx`.

```sh
cd firebase
npm install
npm run login            # opens a browser for firebase login
npm run use               # pick/link your Firebase project (or edit .firebaserc by hand)

cd functions && npm install && cd ..
npm run deploy            # deploys Firestore rules + the aggregation function
```

Other scripts available in `firebase/package.json`:

- `npm run deploy:rules` — Firestore rules only
- `npm run deploy:functions` — Cloud Functions only
- `npm run emulators` — run Firestore + Functions locally for testing

## 3. Configure the extension

Edit `extension/config.js` with the values from step 1:

```js
export const FIREBASE_CONFIG = {
  apiKey: "...",
  projectId: "...",
};
```

## 4. Load the extension in Chrome

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Open any `youtube.com/watch?v=...` video — a small **NonSlop** widget
   appears in the bottom-right corner. Click the extension icon in the
   toolbar for the same controls in a popup.

## Notes / next steps

- Identity is anonymous-only for a frictionless MVP; votes are tied to a
  device-local Firebase UID, not a Google account.
- Icons in `extension/icons/` are placeholder generated art — swap in real
  branding before publishing to the Chrome Web Store.
- To publish, zip the `extension/` folder and upload it via the
  [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
