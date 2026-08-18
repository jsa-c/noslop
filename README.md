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

- **Sign-in is mandatory and Google-only.** The extension no longer offers
  anonymous auth. `extension/background.js` gets a Google access token via
  `chrome.identity.getAuthToken` and exchanges it for a Firebase session
  (`accounts:signInWithIdp`, provider `google.com`). Nothing — not even
  reading the community score — works until the user signs in.
- Each signed-in user can cast one vote per video:
  `videos/{videoId}/votes/{uid}` → `{ isSlop: boolean }` (true = slop, false
  = explicitly not slop). Users can only read/write their own vote document,
  and only if their session's `sign_in_provider` is `google.com` — enforced
  by `firebase/firestore.rules`, not just by the client.
- A Cloud Function (`firebase/functions/index.js`) listens for vote writes
  and recomputes `videos/{videoId}.slopCount` / `.totalVotes`. Clients can
  only *read* that aggregate doc, never write it, so nobody can fake the
  public score.
- The extension talks to Firebase over its plain REST APIs (Identity
  Toolkit + Firestore) from the background service worker — no bundler
  required, and the Web API key is safe to ship since it doesn't grant any
  access on its own (the security rules do that).
- **Voting UI, two places:** the floating widget (bottom-right of the page)
  has a single "Mark as Slop" toggle, and a **Slop / Not Slop** button pair
  is injected next to YouTube's own like/dislike row (falls back gracefully
  — just doesn't appear — if YouTube's markup doesn't match any of the
  selectors `extension/content.js` tries). Both read from and write to the
  same vote, so they always agree.
- Optional **auto-skip**: toggle "Auto-skip videos with a high slop score"
  in the popup and the content script will jump to one second before the
  end of any video whose slop score (`slopCount / totalVotes`) meets the
  threshold hardcoded in `extension/content.js`
  (`AUTO_SKIP_SLOP_SCORE_THRESHOLD`, currently `1` — unanimous votes only),
  so YouTube's own "up next" autoplay takes over immediately. A toast at the
  top of the page announces the skip ("This video is sloppy — skipping…")
  for a few seconds. The setting is stored in `chrome.storage.sync`.
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
2. **Build → Authentication → Sign-in method** → enable **Google**. (Leave
   Anonymous off — the extension only ever signs in with Google, and the
   Firestore rules reject anything else.)
3. **Build → Firestore Database** → create a database (production mode is
   fine; the rules below control access).
4. **Project settings → General → Your apps** → add a **Web app** and copy
   its `apiKey` and `projectId`.

### Google OAuth client for the extension

Sign-in goes through `chrome.identity.getAuthToken`, which needs an OAuth
2.0 client registered for this specific extension:

1. In the [Google Cloud Console](https://console.cloud.google.com) for the
   *same* GCP project as your Firebase project, go to **APIs & Services →
   Credentials → Create Credentials → OAuth client ID**.
2. Application type **Chrome Extension**.
3. It needs the extension's ID. For an unpacked/dev install, that ID
   changes every reload unless you pin it: load the extension once, copy
   the generated ID from `chrome://extensions`, then add a matching `"key"`
   field to `extension/manifest.json` (**Details → ID** on the extension's
   card, or export the `.pem` Chrome generated for it) so the ID stays
   fixed across reloads. Use that fixed ID when creating the OAuth client.
4. Configure the **OAuth consent screen** for the project if you haven't
   already (internal or external, `openid`/`email`/`profile` scopes).
5. Copy the resulting Client ID into `extension/manifest.json`'s
   `oauth2.client_id`.

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

Edit `extension/config.js` with the values from step 1, and
`extension/manifest.json`'s `oauth2.client_id` with the OAuth client ID from
the previous section:

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
   appears bottom-right, and Slop/Not Slop buttons appear next to the
   like/dislike row. Both start gated behind a **Sign in with Google**
   button until you sign in (also available in the toolbar popup). If the
   OAuth client ID's extension ID doesn't match this install's actual ID,
   sign-in will fail — see the pinning step above.

## Notes / next steps

- Google accounts are free to create, so requiring sign-in raises the bar
  on vote manipulation but doesn't eliminate it — there's still no
  per-account rate limiting, and nothing stops one person from voting from
  several Google accounts.
- `firebase/functions/package.json` pins `engines.node`; Firebase's Node 20
  runtime is scheduled for decommission 2026-10-30, so that pin will need to
  move again before then or deploys will stop working.
- Icons in `extension/icons/` are placeholder generated art — swap in real
  branding before publishing to the Chrome Web Store.
- To publish, zip the `extension/` folder and upload it via the
  [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
  Note the Chrome Web Store assigns the extension a permanent ID on first
  publish — you'll need to update the OAuth client (and `manifest.json`'s
  `key`, if you were relying on it for local pinning) to match.
