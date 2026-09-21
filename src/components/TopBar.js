/* Top bar — data-driven pill nav (plan: topbar redesign, Figma-style max-3
 * pill + More). Presentational: all auth calls live in the store (startDraft
 * keeps its sign-in gate); me and me.isAdmin come from GET /api/me via the
 * store. The pill shows AT MOST two view items, always including the active
 * view; every other visible view folds into a "More" dropdown. Signed in,
 * the avatar chip opens an account-only menu (identity header + sign out);
 * signed out, a "Sign in with Google" ghost. Right cluster order: Export
 * area (ghost) → auth → exactly one accent CTA ("Submit a sim"), always
 * last. The GitHub repo chip sits in the brand mark, on the title row
 * beside the headline (the tagline wraps below). The vestigial
 * 'submissions' view value stays harmless — it is not a nav entry. */
import React from 'react';

const h = React.createElement;

/* One entry per view, in order — adding a view = adding an entry here. */
export const NAV_ITEMS = [
  { id: 'discover', label: 'Discover', show: () => true },
  { id: 'contribute', label: 'Contribute', show: () => true },
  { id: 'capture', label: 'Capture', show: () => true },
  { id: 'dashboard', label: 'Dashboard',
    show: (user, me) => Boolean(user && me) },
  { id: 'tutorials', label: 'Tutorials', show: () => true },
  { id: 'privacy', label: 'Privacy', show: () => true },
  { id: 'admin', label: 'Admin',
    show: (user, me) => Boolean(user && me && me.isAdmin) },
];

/* Visible nav entries for this auth state, in config order. */
export function visibleItems(user, me) {
  return NAV_ITEMS.filter((item) => item.show(user, me));
}

/* Max-3 pill split: the active view always occupies a visible slot — its
 * positional one when it sits in the first two, otherwise it swaps into
 * slot 2 beside the first entry; everything else returns as `more`, in
 * config order. */
export function pillSplit(active, visible) {
  const head = visible.slice(0, 3);
  const shown = head.some((item) => item.id === active)
    ? head
    : [visible[0], visible.find((item) => item.id === active)]
      .filter(Boolean);
  const shownIds = new Set(shown.map((item) => item.id));
  return { shown, more: visible.filter((item) => !shownIds.has(item.id)) };
}

/* Shared dropdown shell: the document listeners (outside click + Escape)
 * exist only while open; children({open, onClose}) render the trigger and
 * panel so a pick can close its own menu. */function DropdownMenu({ open, onClose, children }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return h('div', { className: 'menu-wrap', ref },
    children({ open, onClose }));
}

/* One crisp SVG chevron for every dropdown trigger — a text-glyph chevron
 * renders from a fallback font and drifts off the label's baseline. Sized
 * by .chev; stroke inherits the button color via currentColor. */
const CHEV = h('svg', { className: 'chev', viewBox: '0 0 12 12',
  'aria-hidden': 'true' },
  h('path', { d: 'M2.5 4.5 6 8 9.5 4.5', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5,
    strokeLinecap: 'round', strokeLinejoin: 'round' }));

/* Open-source repo chip: on the brand mark's title row, beside the
 * headline — the classic octicon GitHub mark on the 16-grid, filled via
 * currentColor so it follows the link's ink like the buttons. */
export const GITHUB_URL = 'https://github.com/judeosbert/openbengaluru';

const GH_MARK = h('svg', { className: 'ghmark', viewBox: '0 0 16 16',
  'aria-hidden': 'true' },
  h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59'
    + '.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94'
    + '-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 '
    + '1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89'
    + '-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 '
    + '2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 '
    + '2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75'
    + '-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.'
    + '38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z', fill: 'currentColor' }));

export function TopBar({ view, onView, user, me, onSignIn, onSignOut, onNewSim, onExport }) {
  const { shown, more } = pillSplit(view, visibleItems(user, me));
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [acctOpen, setAcctOpen] = React.useState(false);
  const closeMore = React.useCallback(() => setMoreOpen(false), []);
  const closeAcct = React.useCallback(() => setAcctOpen(false), []);
  const identity = user ? (user.displayName || user.email || user.uid) : '';
  return h('div', { className: 'topbar' },
    h('div', { className: 'mark' },
      h('i', null), 'OpenBengaluru ',
      h('a', { key: 'gh', className: 'gh', href: GITHUB_URL,
        target: '_blank', rel: 'noreferrer noopener',
        'aria-label': 'GitHub' }, GH_MARK),
      h('small', null, 'WHAT WOULD YOU CHANGE?')),
    h('div', { className: 'viewtoggle' },
      shown.map((item) => h('button', {
        key: item.id,
        className: view === item.id ? 'on' : '',
        onClick: () => onView(item.id),
      }, item.label)),
      more.length > 0 ? h(DropdownMenu, {
        key: 'more', open: moreOpen, onClose: closeMore,
      }, ({ open, onClose }) => [
        h('button', {
          key: 'more-toggle',
          className: open ? 'on' : '',
          onClick: () => setMoreOpen(!open),
        }, 'More', CHEV),
        open ? h('div', { key: 'more-panel', className: 'more-menu' },
          more.map((item) => h('button', {
            key: item.id,
            onClick: () => { onView(item.id); onClose(); },
          }, item.label))) : null,
      ]) : null),
    h('div', { className: 'userbox' },
      h('button', { className: 'ghost', onClick: onExport }, 'Export area'),
      user ? h(DropdownMenu, {
        key: 'account', open: acctOpen, onClose: closeAcct,
      }, ({ open, onClose }) => [
        h('button', {
          key: 'chip', className: 'avatar',
          onClick: () => setAcctOpen(!open),
        },
        h('span', { key: 'ph', className: 'ph' },
          identity.charAt(0).toUpperCase()),
        identity,
        CHEV),
        open ? h('div', { key: 'panel', className: 'account-menu' },
          h('div', { key: 'who', className: 'who' },
            'SIGNED IN · ' + user.email),
          h('button', { key: 'out', onClick: onSignOut }, 'Sign out'))
          : null,
      ])
        : h('button', { key: 'signin', className: 'ghost', onClick: onSignIn },
          'Sign in with Google'),
      h('button', { onClick: onNewSim }, 'Submit a sim')));
}
