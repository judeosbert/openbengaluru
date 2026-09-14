/* Tutorials page (plan: tutorials page) — data-shape + URL-parse assertions
 * for the pure module src/lib/tutorials.js (the curated RoadwayVR playlist), plus wiring checks pinning the public
 * TopBar Tutorials toggle (against the NAV_ITEMS config the pill nav
 * renders from), App's 'tutorials' overlay branch, and the static view
 * component. */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TUTORIALS, PLAYLIST_URL, youtubeId, embedUrl }
  from '../src/lib/tutorials.js';
import * as topbar from '../src/components/TopBar.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

/* data shape: every tutorial carries title/blurb/url as non-empty strings;
 * titles are unique (card keys + list scannability). */
it('lists tutorials, each with title/blurb and a YouTube URL', () => {
  expect(Array.isArray(TUTORIALS) && TUTORIALS.length > 0,
    'TUTORIALS must be a non-empty array').toBe(true);
  const titles = TUTORIALS.map((t) => t.title);
  expect(new Set(titles).size, 'tutorial titles must be unique')
    .toBe(titles.length);
  for (const t of TUTORIALS) {
    for (const f of ['title', 'blurb', 'url']) {
      expect(typeof t[f] === 'string' && t[f].trim(),
        `${t.title || '?'}: ${f} must be a non-empty string`).toBeTruthy();
    }
    expect(t.url, `${t.title}: url must be a YouTube link`)
      .toMatch(/^(https:\/\/(www\.)?youtube\.com\/|https:\/\/youtu\.be\/)/);
  }
});

/* every tutorial link must resolve to an 11-char video id so the view can
 * embed it (playlist videos included). */
it('every tutorial URL parses to an 11-char video id', () => {
  for (const t of TUTORIALS) {
    expect(youtubeId(t.url), `${t.title}: must parse to a video id`)
      .toMatch(/^[A-Za-z0-9_-]{11}$/);
  }
});

/* the page ships a curated playlist link (list= param, no video id). */
it('PLAYLIST_URL is a playlist link with a list id and no video id', () => {
  expect(PLAYLIST_URL).toMatch(/^https:\/\/(www\.)?youtube\.com\/playlist\?/);
  expect(youtubeId(PLAYLIST_URL),
    'playlist links carry no video id').toBeNull();
});

/* URL parsing is the shared pure helper — pin all common YouTube forms plus
 * the rejection cases the view relies on. */
it('youtubeId parses watch / youtu.be / embed / shorts / live forms', () => {
  expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
    .toBe('dQw4w9WgXcQ');
  expect(youtubeId('https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s'))
    .toBe('dQw4w9WgXcQ');
  expect(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=3')).toBe('dQw4w9WgXcQ');
  expect(youtubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'))
    .toBe('dQw4w9WgXcQ');
  expect(youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'))
    .toBe('dQw4w9WgXcQ');
  expect(youtubeId('https://www.youtube.com/live/dQw4w9WgXcQ'))
    .toBe('dQw4w9WgXcQ');
});

it('youtubeId rejects non-YouTube hosts, junk and malformed ids', () => {
  expect(youtubeId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  expect(youtubeId('https://www.youtube.com/playlist?list=PLabc123456789'))
    .toBeNull();
  expect(youtubeId('https://www.youtube.com/watch?v=short')).toBeNull();
  expect(youtubeId('https://youtu.be/')).toBeNull();
  expect(youtubeId('not a url')).toBeNull();
  expect(youtubeId('')).toBeNull();
  expect(youtubeId(null)).toBeNull();
});

/* embedUrl feeds the iframe src directly — videos get the nocookie player,
 * playlists get the videoseries player, junk gets null. */
it('embedUrl builds the nocookie embed for videos and playlists', () => {
  expect(embedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
    .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  expect(embedUrl('https://youtu.be/dQw4w9WgXcQ'))
    .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  expect(embedUrl('https://www.youtube.com/playlist?list=PLabc123456789'))
    .toBe('https://www.youtube-nocookie.com/embed/videoseries'
      + '?list=PLabc123456789');
  expect(embedUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
});

/* TopBar wiring (pill redesign): Tutorials is a PUBLIC entry of the
 * NAV_ITEMS config — visible signed-out, ordered after Contribute. */
it('TopBar exposes a public Tutorials toggle after Contribute', () => {
  const { NAV_ITEMS } = topbar;
  expect(Array.isArray(NAV_ITEMS), 'TopBar must export a NAV_ITEMS config')
    .toBe(true);
  const ids = NAV_ITEMS.map((i) => i.id);
  expect(ids, "TopBar must toggle the 'tutorials' view").toContain('tutorials');
  expect(ids.indexOf('tutorials'),
    'Tutorials must come after Contribute in the nav config')
    .toBeGreaterThan(ids.indexOf('contribute'));
  expect(NAV_ITEMS.find((i) => i.id === 'tutorials').show(null, null),
    'Tutorials must be public — visible signed out').toBe(true);
});

/* App wiring: 'tutorials' renders the TutorialsView overlay like
 * contribute/dashboard/admin. */
it("App renders TutorialsView for the 'tutorials' view", () => {
  const s = fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'components', 'App.js'), 'utf8');
  expect(s, 'App must import TutorialsView')
    .toMatch(/import \{ TutorialsView \} from '\.\/TutorialsView\.js';/);
  expect(s, "App must branch store.view === 'tutorials' to TutorialsView")
    .toMatch(/store\.view === 'tutorials' \? h\(TutorialsView, \{ store \}\) : null/);
});

/* the view is entirely static: no API calls, copy + URLs come from the lib
 * module, embeds come from embedUrl, and the playlist row renders. */
it('TutorialsView is static and renders the playlist + embedded videos', () => {
  const s = fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'components', 'TutorialsView.js'), 'utf8');
  expect(s, 'copy must come from the pure lib module')
    .toMatch(/from '\.\.\/lib\/tutorials\.js'/);
  expect(s, 'no API calls — the page is entirely static')
    .not.toMatch(/fetch\(|from '\.\.\/api\.js'/);
  expect(s, 'the playlist row must render').toMatch(/FULL PLAYLIST/);
  expect(s, 'embeds must come from the shared embedUrl helper')
    .toMatch(/embedUrl\(/);
  expect(s, 'videos must render as lazy iframes').toMatch(/loading: 'lazy'/);
});