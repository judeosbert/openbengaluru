/* Capture guide copy — pure data, zero imports (src/lib stays DOM-free
 * and react-free; enforced by test/lib-purity.test.js). The four pedestrian
 * capture-method cards (plan: capture-leaderboard page) teach ultra-short
 * field recordings; METHODS is the upload widget's enum — the same ids the
 * server validates; sha256Hex is the client-side duplicate short-circuit
 * (crypto.subtle digest -> lowercase hex; the server recomputes over the
 * buffered bytes and never trusts this value). Shape is locked by
 * test/capture.test.js. */

export const METHODS = ['snapshot', 'footbridge', 'stopwatch', 'other'];

export const GUIDE_METHODS = [
  {
    title: '30-second snapshot',
    ask: 'Stand at one spot at the junction and record for 30 seconds — '
      + 'hold the camera still, no panning, no zooming.',
    whyItWorks: 'A fixed 30-second take from one spot is long enough to '
      + 'show queue build-up and release, and short enough to record on any '
      + 'phone between two signals.',
    howItIsUsed: 'The clip is the ground truth for that junction at that '
      + 'minute — reviewers check the simulated vehicle mix, queues and '
      + 'signal behaviour against what really happened.',
  },
  {
    title: 'Footbridge clip',
    ask: 'From a footbridge or overpass, record for 30 seconds straight '
      + 'down at the traffic below.',
    whyItWorks: 'From above, every vehicle, gap and lane is visible at '
      + 'once — the single most useful angle for judging how traffic '
      + 'actually flows through a junction.',
    howItIsUsed: 'Lane-by-lane counts and gaps from the clip calibrate the '
      + 'simulated per-lane flows and catch modelling artefacts a street '
      + 'view would hide.',
  },
  {
    title: 'Traffic-light stopwatch',
    ask: 'At a signal, time one full red-green cycle: note the junction, '
      + 'how long the green lasted and how many vehicles crossed while it '
      + 'was green.',
    whyItWorks: 'Signal timing plus the released-vehicle count pins down '
      + 'saturation flow — the number every simulated traffic light turns '
      + 'on.',
    howItIsUsed: 'Reviewers compare the measured green split and release '
      + 'count against the simulated cycle to check the timing plan. No '
      + 'form to fill — put the numbers in the clip or the junction note.',
  },
  {
    title: 'Upload on Wi-Fi',
    ask: 'Record on the road, upload later when you are on Wi-Fi — clips '
      + 'are large and mobile data is not.',
    whyItWorks: 'The upload waits for you: the widget accepts a file you '
      + 'recorded earlier, whenever you pick it — there is no offline '
      + 'queue to manage.',
    howItIsUsed: 'Exactly like a live upload — every accepted capture adds '
      + 'one point to the all-time leaderboard.',
  },
];

/* The leaderboard scoring strip on the Capture page. */
export const LEADERBOARD_NOTE = 'All-time leaderboard — 1 point per '
  + 'accepted capture. Every clip or photo you upload from the road counts '
  + 'once, whatever the method or size.';

/* Client-side SHA-256 over bytes (the upload widget's duplicate
 * short-circuit): hex digest via crypto.subtle — needs a secure context
 * (https/localhost). The server ALWAYS recomputes; this is a fast-fail
 * convenience only. */
export async function sha256Hex(bytes) {
  const data = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes) : bytes;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}