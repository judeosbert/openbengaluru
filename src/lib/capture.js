/* Capture guide copy — pure data, zero imports (src/lib stays DOM-free
 * and react-free; enforced by test/lib-purity.test.js). The three pedestrian
 * capture-method cards (plan: capture-leaderboard page) teach ultra-short
 * field recordings; METHODS is the upload widget's enum — the same ids the
 * server validates (stopwatch + other removed: the roster is snapshot +
 * footbridge); sha256Hex is the client-side duplicate short-circuit
 * (crypto.subtle digest -> lowercase hex; the server recomputes over the
 * buffered bytes and never trusts this value). COMPETITION_RULES is the
 * competition-terms copy for the Capture page's rules popup — a title plus
 * eight numbered sections; a block is a paragraph (p) or a bullet list
 * (ul); **bold** markers ride in the text and render as strong spans in
 * the view. Shape is locked by test/capture.test.js. */

export const METHODS = ['snapshot', 'footbridge'];

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

/* Competition rules popup (a Rules text link above the tab bar opens it):
 * verbatim competition terms — title + eight numbered sections; a block is
 * { p: 'paragraph' } or { ul: ['item', ...] }; **bold** renders strong. */
export const COMPETITION_RULES = {
  title: 'OpenBengaluru Capture — Competition Rules',
  sections: [
    {
      heading: '1. The Challenge',
      blocks: [
        { p: 'Contribute useful, real-world data to OpenBengaluru during '
          + 'the competition period and help build a better picture of the '
          + 'city.' },
      ],
    },
    {
      heading: '2. Competition Period',
      blocks: [
        { p: 'The competition will run for **21 days**.' },
        { p: 'The exact start and end dates will be announced on the '
          + 'OpenBengaluru Capture page.' },
      ],
    },
    {
      heading: '3. How Points Work',
      blocks: [
        { ul: [
          'Points are awarded **only for accepted submissions**.',
          'Every accepted submission earns points based on its type and '
            + 'value.',
          'Rejected, duplicate, incomplete, or invalid submissions earn '
            + '**0 points**.',
          'Submissions made outside the competition period will not count.',
          'Points may be adjusted or removed if a submission is later found '
            + 'to be incorrect or invalid.',
        ] },
      ],
    },
    {
      heading: '4. Quality Over Quantity',
      blocks: [
        { p: 'The goal is to collect **useful and accurate data**, not '
          + 'simply the highest number of submissions.' },
        { p: 'Please submit observations that are:' },
        { ul: [
          'Accurate and based on what you actually observed.',
          'Clearly documented.',
          'Relevant to the requested data.',
          'Not duplicates of existing submissions.',
        ] },
        { p: 'Submitting large numbers of low-quality or duplicate entries '
          + 'will not improve your score.' },
      ],
    },
    {
      heading: '5. Validation',
      blocks: [
        { p: 'All submissions are subject to review.' },
        { p: 'A submission becomes eligible for points **only after it has '
          + 'been accepted** through the OpenBengaluru validation process.' },
        { p: 'OpenBengaluru may reject submissions that are inaccurate, '
          + 'unverifiable, duplicated, incomplete, misleading, or otherwise '
          + 'unsuitable for the dataset.' },
      ],
    },
    {
      heading: '6. Winner',
      blocks: [
        { p: 'At the end of the competition, the contributor with the '
          + '**highest number of valid points** will be the winner.' },
        { p: '🏆 **Prize: ₹500 voucher**' },
        { p: 'In the event of a tie, the winner will be determined based on '
          + 'the number of accepted submissions, followed by the acceptance '
          + 'rate.' },
      ],
    },
    {
      heading: '7. Fair Play',
      blocks: [
        { p: 'Please participate honestly.' },
        { p: 'Do not:' },
        { ul: [
          'Submit fabricated observations.',
          'Submit the same observation repeatedly.',
          'Alter or manipulate evidence.',
          'Create submissions solely to gain points.',
          'Use automated or otherwise abusive methods to generate '
            + 'submissions.',
        ] },
        { p: 'Submissions found to violate these rules may be removed and '
          + 'their points deducted.' },
      ],
    },
    {
      heading: '8. The Bigger Goal',
      blocks: [
        { p: 'The competition is only a way to get more people involved.' },
        { p: 'The real goal is to build an **open, community-driven dataset '
          + 'of Bengaluru** that anyone can use to understand, analyse, and '
          + 'improve the city.' },
      ],
    },
  ],
};

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