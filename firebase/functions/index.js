const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// Clients can only write their own vote document at
// videos/{videoId}/votes/{uid}. This trigger is the sole writer of the
// aggregate counters on videos/{videoId}, so users can never inflate or
// tamper with the public slop score directly.
exports.onVoteWritten = onDocumentWritten("videos/{videoId}/votes/{uid}", async (event) => {
  const { videoId } = event.params;
  const before = event.data.before.exists ? event.data.before.data() : null;
  const after = event.data.after.exists ? event.data.after.data() : null;

  const totalDelta = (after ? 1 : 0) - (before ? 1 : 0);
  const slopDelta = (after?.isSlop ? 1 : 0) - (before?.isSlop ? 1 : 0);

  if (totalDelta === 0 && slopDelta === 0) return;

  const videoRef = db.collection("videos").doc(videoId);
  const update = {
    totalVotes: FieldValue.increment(totalDelta),
    slopCount: FieldValue.increment(slopDelta),
    lastUpdated: FieldValue.serverTimestamp(),
  };
  if (after?.videoTitle) update.title = after.videoTitle;

  await videoRef.set(update, { merge: true });
});
