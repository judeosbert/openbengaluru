/* Top bar. Ported verbatim from app.js. */
import React from 'react';

const h = React.createElement;

export function TopBar({ view, onView, username, onUsername, onNewSim, onExport }) {
  return h('div', { className: 'topbar' },
    h('div', { className: 'mark' },
      h('i', null), 'SIMO ', h('small', null, 'BENGALURU TRAFFIC LAB')),
    h('div', { className: 'viewtoggle' },
      h('button', {
        className: view === 'discover' ? 'on' : '',
        onClick: () => onView('discover'),
      }, 'Discover'),
      h('button', {
        className: view === 'submissions' ? 'on' : '',
        onClick: () => onView('submissions'),
      }, 'My Submissions')),
    h('div', { className: 'userbox' },
      h('span', null, 'SIGNED IN AS'),
      h('input', {
        type: 'text', placeholder: 'username', value: username,
        onChange: (ev) => onUsername(ev.target.value),
      }),
      h('button', { className: 'ghost', onClick: onExport }, 'Export area'),
      h('button', { onClick: onNewSim }, 'Submit a sim')));
}
