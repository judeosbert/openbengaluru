/* Top bar. Free-text username replaced by Google sign-in (plan: Firebase
 * Google sign-in) — TopBar stays presentational: all auth calls live in the
 * store. Review flow: signed-in users with a reachable server get
 * "Dashboard"; admins also get "Admin" (me.isAdmin comes from
 * GET /api/me). Contribute is public like Discover (plan: contribute page).
 * The vestigial 'submissions' view value stays harmless. */
import React from 'react';

const h = React.createElement;

export function TopBar({ view, onView, user, me, onSignIn, onSignOut,
  onNewSim, onExport }) {
  const dash = user && me;
  return h('div', { className: 'topbar' },
    h('div', { className: 'mark' },
      h('i', null), 'OpenBengaluru ',
      h('small', null, 'WHAT WOULD YOU CHANGE?')),
    h('div', { className: 'viewtoggle' },
      h('button', {
        className: view === 'discover' ? 'on' : '',
        onClick: () => onView('discover'),
      }, 'Discover'),
      h('button', {
        className: view === 'contribute' ? 'on' : '',
        onClick: () => onView('contribute'),
      }, 'Contribute'),
      h('button', {
        className: view === 'tutorials' ? 'on' : '',
        onClick: () => onView('tutorials'),
      }, 'Tutorials'),
      dash ? h('button', {
        className: view === 'dashboard' ? 'on' : '',
        onClick: () => onView('dashboard'),
      }, 'Dashboard') : null,
      dash && me.isAdmin ? h('button', {
        className: view === 'admin' ? 'on' : '',
        onClick: () => onView('admin'),
      }, 'Admin') : null),
    h('div', { className: 'userbox' },
      user
        ? [
          h('span', { key: 'l' }, 'SIGNED IN AS'),
          h('span', { key: 'n', className: 'username' },
            user.displayName || user.email || user.uid),
          h('button', { key: 'o', className: 'ghost', onClick: onSignOut },
            'Sign out'),
        ]
        : h('button', { className: 'ghost', onClick: onSignIn },
          'Sign in with Google'),
      h('button', { className: 'ghost', onClick: onExport }, 'Export area'),
      h('button', { onClick: onNewSim }, 'Submit a sim')));
}
