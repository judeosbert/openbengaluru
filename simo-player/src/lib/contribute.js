/* Contribute guide copy — pure data, zero imports (src/lib stays DOM-free
 * and react-free; enforced by test/lib-purity.test.js). Six tracks, sixteen
 * roles. The quirky names are UI copy only; blurbs reference features that
 * actually exist: the Submit wizard, the review queue, comment threads and
 * the tools/*.js packer pipeline. Shape is locked by test/contribute.test.js. */

export const TRACKS = [
  {
    title: 'Model the City',
    roles: [
      {
        name: 'Dora',
        subtitle: 'Data contributor',
        does: 'Opens Submit a sim for an area the catalog does not cover yet — '
          + 'draws the export box on the map and supplies the baseline network '
          + 'and demand files for review.',
        start: 'Open Discover, pick a place, Submit a sim.',
      },
      {
        name: 'Fix-It Felix',
        subtitle: 'Baseline data improver',
        does: 'Improves an existing baseline — sharper routes, fresher demand, '
          + 'a proposed-network variant — and sends it back through the review '
          + 'queue.',
        start: 'Pick a covered area, download its files from the sim panel, '
          + 'submit a better baseline.',
      },
      {
        name: 'Yoda',
        subtitle: 'Baseline data master',
        does: 'Does both end to end — authors the baseline, the demand and the '
          + 'proposed changes for whole areas, and shepherds each submission '
          + 'through review.',
        start: 'Claim an uncovered area and take it from empty map to active sim.',
      },
    ],
  },
  {
    title: 'Build the Platform',
    roles: [
      {
        name: 'Bob the Builder',
        subtitle: 'Engineer',
        does: 'Builds the platform itself — the player UI, server.js and its '
          + 'review API, the db/bucket persistence, and the tools/*.js packer '
          + 'pipeline.',
        start: 'Clone the repo, read CLAUDE.md, npm run dev, fix something real.',
      },
      {
        name: 'Dory',
        subtitle: 'Product manager',
        does: 'Finds the way — turns what contributors and viewers need into '
          + 'concrete, shippable slices and keeps the roadmap honest.',
        start: 'Use the app end to end as a first-timer and write down every '
          + 'place it confused you.',
      },
      {
        name: 'Picasso',
        subtitle: 'Designer / visualizer',
        does: 'Owns the look — map overlays, panels, chips and dashboards — so '
          + 'dense traffic data reads clearly at a glance.',
        start: 'Open Discover and the dashboards, then sketch one screen that '
          + 'reads better.',
      },
      {
        name: 'Wreck-It Ralph',
        subtitle: 'QA / tester',
        does: 'Breaks it on purpose — wizard submits, review flows, malformed '
          + 'files, boundary cases — and turns every repro into a failing '
          + 'vitest case.',
        start: 'Run npm test, then try to wreck the Submit wizard with junk input.',
      },
    ],
  },
  {
    title: 'Explain the City',
    roles: [
      {
        name: 'C-3PO',
        subtitle: 'Data scientist',
        does: 'Turns sims into readable reports — the stats stream (throughput, '
          + 'moving, stopped, queued, gridlock) becomes plots and '
          + 'plain-language findings.',
        start: 'Play an active sim, read its stat panel, publish one finding '
          + 'worth sharing.',
      },
      {
        name: 'Gandalf',
        subtitle: 'Methodology reviewer',
        does: 'Guards how conclusions are drawn — demand assumptions, network '
          + 'edits, scenario choices — so published results hold up under '
          + 'scrutiny.',
        start: 'Read one active sim end to end and question its assumptions '
          + 'in the comments.',
      },
    ],
  },
  {
    title: 'Amplify & Advocate',
    roles: [
      {
        name: 'Paul Revere',
        subtitle: 'Advocate / influencer',
        does: 'Spreads the word — turns an active sim\'s findings into posts, '
          + 'threads and press that make the problem impossible to ignore.',
        start: 'Pick an active sim and share its numbers where commuters '
          + 'already gather.',
      },
      {
        name: 'Rocky',
        subtitle: 'Government liaison',
        does: 'Takes the evidence to the authorities — and stays on it, the '
          + 'follow-up after the follow-up, until someone official replies.',
        start: 'Pick a corridor the sims cover and draft the one-page ask.',
      },
    ],
  },
  {
    title: 'Guard the Gate',
    roles: [
      {
        name: 'Zuul',
        subtitle: 'Reviewer',
        does: 'Guards the gate — works the review queue: activates honest sims, '
          + 'rejects weak ones with a comment saying exactly why, deactivates '
          + 'what aged out.',
        start: 'Once eligible, open the review queue and start from the oldest '
          + 'pending submission.',
        eligibility: 'Zuul becomes available once 5 of your own submissions '
          + "reach status 'active' (approved by an admin).",
      },
    ],
  },
  {
    title: 'Grow the Community',
    roles: [
      {
        name: 'Babel',
        subtitle: 'Translator',
        does: 'Carries the lab past English — the guide, the findings and the '
          + 'interface in Kannada and the city\'s other languages.',
        start: 'Translate this Contribute page into Kannada and send it in.',
      },
      {
        name: 'Alfred',
        subtitle: 'Comment-thread moderator',
        does: 'Keeps the comment threads useful — answers newcomers, keeps '
          + 'debates civil, and summarizes long threads into decisions.',
        start: 'Answer the first unanswered comment you find on a submission.',
      },
      {
        name: 'Obi-Wan',
        subtitle: 'Mentor',
        does: 'Teaches the ways — workshops, pairing sessions, and walking a '
          + 'first-timer from drawing an area to a first accepted submission.',
        start: 'Walk one newcomer through Submit a sim, live.',
      },
      {
        name: 'Scrooge McDuck',
        subtitle: 'Sponsor',
        does: 'Funds the pool — simulation compute and the bucket that stores '
          + 'uploads and review artifacts.',
        start: 'Ask the maintainers what this month costs, then cover it.',
      },
    ],
  },
];

/* The leveling-up strip rendered at the top of the Contribute page: the
 * natural path (Dora -> Fix-It Felix -> Yoda) and the locked Zuul threshold. */
export const LEVELING_UP = 'The natural path: start as Dora (first baseline '
  + 'for an uncovered area), grow into Fix-It Felix (sharper baselines), and '
  + 'become Yoda (whole areas, end to end). Later, guard the gate — Zuul '
  + "unlocks once 5 of your own submissions reach status 'active' (approved "
  + 'by an admin).';