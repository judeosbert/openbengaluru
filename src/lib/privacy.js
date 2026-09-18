/* Privacy page copy — pure data, zero imports (src/lib stays DOM-free and
 * react-free; enforced by test/lib-purity.test.js). The page's promise is
 * the project's promise: no data collection, no tracking, no selling — a
 * community work, stated honestly. Honest means the small amount of data
 * the review flow necessarily handles (Google sign-in identity at submit
 * time, uploaded simulation files, OpenStreetMap tile requests) is owned
 * plainly, not papered over. Shape and the commitment phrases are locked
 * by test/privacy.test.js. */

export const REPO_URL = 'https://github.com/judeosbert/openbengaluru';

export const LEAD = 'OpenBengaluru is a community project, not a business: '
  + 'we do not collect your data, we do not track you, and we will never '
  + 'sell it — there is nothing here to monetise.';

export const PRIVACY_SECTIONS = [
  {
    title: 'The short version',
    paras: [
      'No analytics. No ads. No trackers. No profiling. The map and every '
      + 'simulation on it exist for the community — planners, students and '
      + 'curious citizens of Bengaluru — and that is the whole point. '
      + 'There is no product funnel, no engagement metric and no ad '
      + 'network anywhere in this codebase.',
    ],
  },
  {
    title: 'What little data exists, you give us',
    paras: [
      'Sign-in happens only when you submit a simulation: signing in with '
      + 'Google shares your name and email with the site so your submission '
      + 'has an author, and so we can email you review comments and '
      + 'decisions about your own work.',
      'The simulation files you upload — your SUMO network, routes and '
      + 'scenario details — are stored so reviewers can inspect them and, '
      + 'once approved, the community can run them on the map.',
      'That is the complete list. We log nothing else, we ask for nothing '
      + 'else, and there is no hidden telemetry.',
    ],
  },
  {
    title: 'What we will never do',
    paras: [
      'We will never sell, rent or trade your data — not to advertisers, '
      + 'not to data brokers, not to anyone.',
      'We run no analytics, no advertising and no third-party tracking '
      + 'scripts.',
      'We do not build profiles of you and we do not follow you around '
      + 'the web.',
    ],
  },
  {
    title: 'The only third party: the map tiles',
    paras: [
      'The map loads its tiles from OpenStreetMap\'s public tile servers, '
      + 'governed by the OpenStreetMap Foundation\'s tile usage policy. '
      + 'When your browser fetches a tile, their servers see a standard '
      + 'web request — including your IP address, as with any website — '
      + 'and nothing about you is shared with them by this site beyond '
      + 'that request.',
    ],
  },
  {
    title: 'Your submissions belong to the community',
    paras: [
      'Published simulations are open and credited to you, like the rest '
      + 'of the catalog. If you ever want your submission or its author '
      + 'details removed, open an issue on the GitHub repository and it '
      + 'will be taken down — no questions asked.',
    ],
  },
  {
    title: 'Verify it yourself',
    paras: [
      'This project is fully open source — every claim on this page is '
      + 'checkable in the code. If any of this ever changes, this page '
      + 'changes first.',
    ],
  },
];
