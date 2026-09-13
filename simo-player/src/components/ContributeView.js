/* ContributeView (plan: contribute page) — the public contribution guide:
 * the leveling-up strip plus six tracks of role cards (name, subtitle, what
 * the role does on this platform, first action, eligibility where it exists).
 * Full-screen overlay panel over the map (DashboardView shell pattern); no
 * router, no API calls — all copy comes from the pure src/lib/contribute.js
 * module, so the page renders for anonymous visitors too. */
import React from 'react';
import { TRACKS, LEVELING_UP } from '../lib/contribute.js';

const h = React.createElement;

export function ContributeView({ store }) {
  return h('div', { className: 'dash-veil' },
    h('div', { className: 'dash' },
      h('div', { className: 'dash-head' },
        h('h3', null, 'CONTRIBUTE'),
        h('button', { className: 'ghost',
          onClick: () => store.setView('discover') }, 'Close')),
      h('div', { className: 'row-item' },
        h('div', { className: 'row-line' }, h('b', null, 'LEVELING UP')),
        h('div', { className: 'hint' }, LEVELING_UP)),
      TRACKS.map((track, ti) => h('div', { key: track.title },
        h('h4', null, (ti + 1) + ' · ' + track.title),
        track.roles.map((role) => h('div', { key: role.name,
          className: 'row-item' },
        h('div', { className: 'row-line' },
          h('b', null, role.name),
          h('span', { className: 'meta-inline' }, role.subtitle)),
        h('div', { className: 'hint' }, role.does),
        h('div', { className: 'meta-inline' },
          h('b', null, 'START HERE · '), role.start),
        role.eligibility ? h('div', { className: 'meta-inline' },
          h('b', null, 'ELIGIBILITY · '), role.eligibility) : null))))));
}