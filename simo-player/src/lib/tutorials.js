/* Tutorials page copy — pure data + tiny YouTube URL helpers, zero imports
 * (src/lib stays DOM-free and react-free; enforced by test/lib-purity.test.js).
 * The links below are PLACEHOLDER dummies: swap TUTORIALS[].url and
 * PLAYLIST_URL for the real curated videos/playlist on the maintainers'
 * channel and the page picks them up with zero component changes. Shape and
 * the URL helpers are locked by test/tutorials.test.js. */

export const PLAYLIST_URL =
  'https://www.youtube.com/playlist?list=PLdQw4w9WgXcQdQw4w9WgXcQdQw4w9WgXcQ';

export const TUTORIALS = [
  {
    title: 'Getting started — install SUMO and run your first simulation',
    blurb: 'Install the SUMO toolchain, open netedit, and run a first tiny '
      + 'simulation end to end — the base every submission builds on.',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
  {
    title: 'netedit — draw and edit your network',
    blurb: 'Draw junctions, edges and lanes by hand, fix imported geometry, '
      + 'and export a clean network file for your export box.',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
  {
    title: 'Demand and routing — trips, flows and duarouter',
    blurb: 'Turn real traffic counts into routes: trip definitions, flows, '
      + 'and duarouter to produce the demand file a submission needs.',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
  {
    title: 'Traffic lights, lanes and junction logic',
    blurb: 'Programme signal phases and right-of-way so intersections '
      + 'behave like the street they model.',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
  {
    title: 'Calibration — matching real traffic',
    blurb: 'Compare simulation output against observed counts and tune '
      + 'demand until the numbers hold up under review.',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  },
];

const YT_HOST_RE = /(^|\.)youtube\.com$|^youtu\.be$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID_RE = /^[A-Za-z0-9_-]+$/;

/* Extract the 11-char video id from the common YouTube link forms:
 * watch?v=, youtu.be/<id>, /embed/<id>, /shorts/<id>, /live/<id>, /v/<id>.
 * Playlist links, foreign hosts and junk all return null. */
export function youtubeId(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!YT_HOST_RE.test(u.hostname)) return null;
  let id = null;
  if (u.hostname === 'youtu.be') {
    id = u.pathname.split('/')[1] || null;
  } else if (u.pathname === '/watch') {
    id = u.searchParams.get('v');
  } else {
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/]+)/);
    if (m) id = m[1];
  }
  return id && VIDEO_ID_RE.test(id) ? id : null;
}

/* Extract the list id from a playlist link (youtube.com/playlist?list=…);
 * null when absent or malformed. */
function playlistId(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!YT_HOST_RE.test(u.hostname)) return null;
  const list = u.searchParams.get('list');
  return list && LIST_ID_RE.test(list) ? list : null;
}

/* Embed src for an iframe: videos get the youtube-nocookie player, playlist
 * links get the videoseries player, anything else gets null. */
export function embedUrl(url) {
  const list = playlistId(url);
  if (list) {
    return 'https://www.youtube-nocookie.com/embed/videoseries?list=' + list;
  }
  const vid = youtubeId(url);
  return vid ? 'https://www.youtube-nocookie.com/embed/' + vid : null;
}