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
- **Voting UI, two places:** the floating widget (bottom-right) has a single
  "Mark as Slop" toggle, and a **Slop / Not Slop** button pair is injected
  next to YouTube's own like/dislike row. The inline pair is the only part
  that depends on YouTube's markup — `findActionsBar()` in
  `extension/content.js` tries several known anchors and retries for a few
  seconds after each SPA navigation, and if none match it simply doesn't
  appear rather than breaking the page. Both surfaces read and write the
  same vote, so they never disagree.
- Optional **auto-skip**: toggle "Auto-skip videos with a high slop score"
  in the popup and the content script will jump to **one second before the
  end** of any video whose slop score (`slopCount / totalVotes`) meets the
  threshold hardcoded in `extension/content.js`
  (`AUTO_SKIP_SLOP_SCORE_THRESHOLD`, currently `1` — unanimous votes only),
  so YouTube's own "up next" autoplay takes over. Seeking exactly to
  `duration` can leave the player parked on the final frame instead of
  advancing, hence the one-second margin. A toast across the top of the page
  announces the skip and fades after five seconds. The setting is stored in
  `chrome.storage.sync`.
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

Cloud Functions Gen2 requires the **Blaze (pay-as-you-go)** plan — upgrade
at **Firebase Console → your project → Usage and billing → Modify plan**
before deploying. A hobby-scale deployment still costs close to nothing;
see "Cost controls" below.

`firebase-tools` is pinned in `firebase/package.json`, but in practice
deploys are usually driven by a globally-installed `firebase` CLI (`npm
install -g firebase-tools`) rather than `npx` — keep that global install on
the same major version as the pin (currently `^15`) so `firebase deploy`
behaves the way this repo expects.

```sh
cd firebase
npm install
npm run login            # opens a browser for firebase login
npm run use               # pick/link your Firebase project (or edit .firebaserc by hand)

cd functions && npm install && cd ..
npm run deploy            # deploys Firestore rules + the aggregation functions
```

If the first-ever Cloud Functions Gen2 deploy on a fresh project fails with
an Eventarc/service-agent IAM error, that's a known propagation race — wait
a few minutes and re-run `npm run deploy`.

Other scripts available in `firebase/package.json`:

- `npm run deploy:rules` — Firestore rules only
- `npm run deploy:functions` — Cloud Functions only
- `npm run emulators` — run Firestore + Functions locally for testing

### Cost controls

- Both functions are deployed with `maxInstances: 10` (see `MAX_INSTANCES`
  in `firebase/functions/index.js`) so a burst of writes can't scale up
  unboundedly.
- Set an Artifact Registry cleanup policy on the project (container build
  images otherwise accumulate silently): `gcloud artifacts repositories
  set-cleanup-policies` for the `gcf-artifacts` repo, deleting images older
  than a day or so.
- Consider setting a budget alert in Google Cloud Billing for the project.

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
   appears in the bottom-right corner, and **Slop / Not Slop** buttons
   appear next to the like/dislike row. Click the extension icon in the
   toolbar for the same controls in a popup.

## Notes / next steps

- `firebase/functions/package.json` pins `engines.node`; Firebase's Node 20
  runtime is scheduled for decommission 2026-10-30, so that pin will need to
  move again before then or deploys will stop working.
- Icons in `extension/icons/` are generated by `tools/make_icons.py` (needs
  `pip install Pillow`) — edit the shapes there and re-run it rather than
  hand-editing the PNGs, so all three sizes stay in sync.
- Sign-in is still anonymous (Firebase Anonymous Auth), so votes are tied to
  a device-local UID rather than a real account. That stops one user from
  inflating a count on a single vote document, but not someone minting many
  anonymous UIDs and voting once from each. Mandatory Google sign-in is
  built and parked on the `claude/oauth-google-signin` branch, to be merged
  once its OAuth client is registered.
- To publish, zip the `extension/` folder and upload it via the
  [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
