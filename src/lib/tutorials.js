/* Tutorials page copy — pure data + tiny YouTube URL helpers, zero imports
 * (src/lib stays DOM-free and react-free; enforced by test/lib-purity.test.js).
 * The links are the real curated playlist: RoadwayVR's "SUMO Traffic
 * Simulator Tutorial" series — TUTORIALS[] holds one card per video in
 * playlist order and PLAYLIST_URL links the full playlist, and the page picks
 * them up with zero component changes. Shape and the URL helpers are locked
 * by test/tutorials.test.js. */

export const PLAYLIST_URL =
  'https://www.youtube.com/playlist?list=PLAk8GOoajG6tKI74YID0hwjXVg8KBxNAD';

export const DOC_URL = "https://sumo.dlr.de/docs/index.html";

export const TUTORIALS = [
    {
    title: 'SUMO "Simulation of Urban MObility" Tutorials - See RoadwayVR.com',
    blurb: 'The series overview: what SUMO is and what the tutorial track '
      + 'covers.',
    url: 'https://www.youtube.com/watch?v=QkaODlQj06Q',
  },
  {
    title: 'SUMO Traffic Simulator: Installation & Create a Simple Network',
    blurb: 'Install SUMO, then build and run your first simple network — '
      + 'the base every later episode builds on.',
    url: 'https://www.youtube.com/watch?v=IwsrNWlX9Ag',
  },
  {
    title: 'SUMO Traffic Simulator: Create a Simple Network: Add Cars and '
      + 'Intersection',
    blurb: 'Extend the simple network with an intersection and add cars to '
      + 'run real traffic through it.',
    url: 'https://www.youtube.com/watch?v=raaIVc0xbz0',
  },
  {
    title: 'SUMO Traffic Simulator Part1.3. SUMO Files and Naming Network '
      + 'and Demands',
    blurb: 'The file zoo explained: networks, demands and how SUMO names '
      + 'and links them.',
    url: 'https://www.youtube.com/watch?v=ix4lRFhiCdo',
  },
  {
    title: 'SUMO netedit Tutorial: Quick Start Guide to Building Networks',
    blurb: 'A quick-start tour of netedit for drawing and editing networks '
      + 'by hand.',
    url: 'https://www.youtube.com/watch?v=cRDIIOVmHhI',
  },
    {
    title: 'SUMO Vehicle Types: Car Following & Lane Changing Models',
    blurb: 'Tune vehicle types: car-following and lane-changing models and '
      + 'their parameters.',
    url: 'https://www.youtube.com/watch?v=DMFkkzwW64k',
  },
  {
    title: 'How to Fix Fast Simulation & Jerky Lane Changes in SUMO',
    blurb: 'Diagnose and fix unrealistically fast simulations and jerky '
      + 'lane changes.',
    url: 'https://www.youtube.com/watch?v=9dYSFGDZzFg',
  },

  {
    title: 'Turn SUMO to 3D Visualization for Any City in 5 Minutes – Free '
      + 'Tool (India Example)',
    blurb: 'Turn any city into a 3D SUMO visualization in minutes with a '
      + 'free tool, shown on an India example.',
    url: 'https://www.youtube.com/watch?v=AnrVQ6WHWJg',
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
