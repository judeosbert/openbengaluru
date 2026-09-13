/* TutorialsView (plan: tutorials page) — the public SUMO tutorials page:
 * an intro strip, the curated playlist row (link out; embedUrl supports
 * playlists too), and one card per tutorial — a lazy youtube-nocookie iframe
 * embed plus title, blurb and watch link. Full-screen overlay panel over the
 * map (ContributeView shell pattern); no router, no API calls — all copy and
 * links come from the pure src/lib/tutorials.js module, so the page renders
 * for anonymous visitors too. Links are placeholder dummies until the real
 * curated playlist lands. */
import React from 'react';
import { TUTORIALS, PLAYLIST_URL, embedUrl } from '../lib/tutorials.js';

const h = React.createElement;

const YT_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media;'
  + ' gyroscope; picture-in-picture; web-share';

function ytEmbed(src, title) {
  return h('iframe', {
    className: 'yt-embed',
    src,
    title,
    loading: 'lazy',
    allowFullScreen: true,
    allow: YT_ALLOW,
    frameBorder: '0',
    referrerPolicy: 'strict-origin-when-cross-origin',
  });
}

function ytLink(url) {
  return h('a', {
    className: 'filelink', href: url,
    target: '_blank', rel: 'noreferrer',
  }, 'open on YouTube');
}

export function TutorialsView({ store }) {
  return h('div', { className: 'dash-veil' },
    h('div', { className: 'dash' },
      h('div', { className: 'dash-head' },
        h('h3', null, 'TUTORIALS'),
        h('button', { className: 'ghost',
          onClick: () => store.setView('discover') }, 'Close')),
      h('div', { className: 'row-item' },
        h('div', { className: 'row-line' }, h('b', null, 'LEARN SUMO')),
        h('div', { className: 'hint' },
          'Curated video tutorials for SUMO — from installing the toolchain '
          + 'to building the network and demand files a submission needs. '
          + 'Watch here, or follow the full playlist in order.')),
      h('div', { className: 'row-item' },
        h('div', { className: 'row-line' },
          h('b', null, 'FULL PLAYLIST'),
          h('span', { className: 'meta-inline' },
            'every tutorial in order · ', ytLink(PLAYLIST_URL)))),
      TUTORIALS.map((t) => h('div', { key: t.title, className: 'row-item' },
        ytEmbed(embedUrl(t.url), t.title),
        h('div', { className: 'row-line' },
          h('b', null, t.title)),
        h('div', { className: 'hint' }, t.blurb),
        h('div', { className: 'meta-inline' },
          h('b', null, 'WATCH ON YOUTUBE · '), ytLink(t.url))))));
}