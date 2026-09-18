/* PrivacyView — the public privacy statement: the lead promise, the six
 * statement sections, and the repo link so every claim is verifiable in
 * code. Full-screen overlay panel over the map (ContributeView shell
 * pattern); no router, no API calls — all copy comes from the pure
 * src/lib/privacy.js module, so the page renders for anonymous visitors
 * too. */
import React from 'react';
import { LEAD, PRIVACY_SECTIONS, REPO_URL } from '../lib/privacy.js';

const h = React.createElement;

export function PrivacyView({ store }) {
  return h('div', { className: 'dash-veil' },
    h('div', { className: 'dash' },
      h('div', { className: 'dash-head' },
        h('h3', null, 'PRIVACY'),
        h('button', { className: 'ghost',
          onClick: () => store.setView('discover') }, 'Close')),
      h('div', { className: 'row-item' },
        h('div', { className: 'row-line' }, h('b', null, 'OUR PROMISE')),
        h('div', { className: 'hint' }, LEAD)),
      PRIVACY_SECTIONS.map((s) => h('div', { key: s.title,
        className: 'row-item' },
        h('div', { className: 'row-line' }, h('b', null, s.title)),
        s.paras.map((p, i) => h('div', { key: i, className: 'hint' }, p)))),
      h('div', { className: 'row-item' },
        h('div', { className: 'row-line' },
          h('b', null, 'READ THE CODE'),
          h('span', { className: 'meta-inline' },
            'every claim on this page is checkable in the repo · ',
            h('a', { className: 'filelink', href: REPO_URL,
              target: '_blank', rel: 'noreferrer' }, 'view on GitHub'))))));
}
