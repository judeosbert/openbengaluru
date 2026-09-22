/* CaptureView (plan: capture-leaderboard page) — the public commuter
 * capture page, redesigned after the /tmp/design.html reference: a
 * phone-shell dash panel (brand header, scroll body) holding the dropzone
 * upload card (sign-in gated), the four capture-method
 * accordion cards, and the ranked all-time leaderboard; signed-out
 * visitors get a Google sign-in bottom sheet (store.signIn) instead of the
 * form. Full-screen overlay panel over the map (ContributeView shell
 * pattern); no router. On mobile (<=900px, the house mobile breakpoint)
 * the page takes over the full screen (the topbar steps aside via the
 * TopBar marker) and the upload + leaderboard become TABS — Upload open
 * by default, the active pane swapped by data-tab CSS; desktop keeps the
 * sections stacked in the fixed order upload widget -> guide cards ->
 * leaderboard (pinned by test/capture.test.js via the section markers).
 * Copy comes from the pure
 * src/lib/capture.js module; ALL transport goes through src/api.js
 * wrappers (uploadCapture / fetchLeaderboard) — no direct fetch in this
 * component, and tokens are never touched here.
 *
 * A 'Rules' text link sits in the header bar, right of the CAPTURE
 * heading, and opens the competition-rules popup over the dash — verbatim
 * copy from the lib module's COMPETITION_RULES; a centered dialog whose
 * body scrolls (outside-tap, X and Escape close it).
 *
 * An accepted upload swaps the WHOLE body for a success moment ("Upload
 * Successful" instead of the form) and auto-advances to the Leaderboard
 * tab; the sticky bottom CTA bar is gone — the dropzone is the single
 * entry point into the picker.
 *
 * No location capture — the form collects junction/method/time only. The
 * client-side sha256Hex digest is a duplicate short-circuit only — the
 * server recomputes over the received bytes. */
import React from 'react';
import { GUIDE_METHODS, METHODS, LEADERBOARD_NOTE, sha256Hex,
  COMPETITION_RULES } from '../lib/capture.js';
import { G_MARK } from './SignInGate.js';
import { uploadCapture, fetchLeaderboard } from '../api.js';

const h = React.createElement;

const LB_LIMIT = 50;   // the server-side top; 'show all' expands to this

/* the upload success moment auto-advances to the Leaderboard tab */
const SUCCESS_MS = 1600;

/* datetime-local needs a local-wall-clock "YYYY-MM-DDTHH:mm" string. */
function toLocalInput(d) {
  if (!d || Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
}

/* Leaderboard/avatar initials: first + last initial, uppercase
 * ('Jordan D.' -> 'JD'; a single word keeps its first letter). */
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (parts[0][0] + last).toUpperCase();
}

/* **bold** markers in the rules copy render as strong runs — the lib
 * module keeps the markdown emphasis, the view splits on it. */
function mdRuns(text) {
  const parts = String(text).split('**');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    out.push(i % 2 === 1 ? h('strong', { key: i }, parts[i]) : parts[i]);
  }
  return out;
}

/* Minimal stroke-glyph set for the redesign (lucide-style 24-box paths).
 * Decorative only — every color flows through currentColor + tokens. */
const GLYPHS = {
  video: [['path', { d: 'm22 8-6 4 6 4V8Z' }],
    ['rect', { x: 2, y: 6, width: 14, height: 12, rx: 2 }]],
  camera: [['path', { d: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16'
    + 'a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z' }],
  ['circle', { cx: 12, cy: 13, r: 3 }]],
  arrowDown: [['path', { d: 'M12 5v14' }],
    ['path', { d: 'm19 12-7 7-7-7' }]],
  wifi: [['path', { d: 'M12 20h.01' }],
    ['path', { d: 'M2 8.82a15 15 0 0 1 20 0' }],
    ['path', { d: 'M5 12.86a10 10 0 0 1 14 0' }],
    ['path', { d: 'M8.82 17a5 5 0 0 1 7.94 0' }]],
  upload: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
    ['path', { d: 'm17 8-5-5-5 5' }],
    ['path', { d: 'M12 3v12' }]],
  file: [['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 '
    + '2-2V7Z' }],
  ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }]],
  chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  shield: [['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C'
    + '7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 '
    + '0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }],
  ['path', { d: 'm9 12 2 2 4-4' }]],
  trophy: [['path', { d: 'M6 9H4.5a2.5 2.5 0 0 1 0-5H6' }],
    ['path', { d: 'M18 9h1.5a2.5 2.5 0 0 0 0-5H18' }],
    ['path', { d: 'M4 22h16' }],
    ['path', { d: 'M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 '
      + '22' }],
    ['path', { d: 'M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 '
      + '22' }],
    ['path', { d: 'M18 2H6v7a6 6 0 0 0 12 0V2Z' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
};

function Icon({ name, className }) {
  return h('svg', { className, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
    strokeLinejoin: 'round', 'aria-hidden': 'true' },
  (GLYPHS[name] || []).map(([tag, props], i) => h(tag, { key: i, ...props })));
}

/* one glyph per guide card, in GUIDE_METHODS order (token-tinted tiles) */
const ACC_GLYPHS = ['camera', 'arrowDown', 'wifi'];

export function CaptureView({ store }) {
  const signedIn = Boolean(store.user);
  const [junction, setJunction] = React.useState('');
  const [method, setMethod] = React.useState('snapshot');
  const [file, setFile] = React.useState(null);
  const [capturedAt, setCapturedAt] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [entries, setEntries] = React.useState(null);
  const [showAll, setShowAll] = React.useState(false);
  /* sign-in bottom sheet (signed-out visitors) + accordion open index */
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [accOpen, setAccOpen] = React.useState(0);
  /* tabs: Upload | Leaderboard, upload open by default — the same tab
   * swap at every width (the CSS pane rules are universal, not mobile) */
  const [tab, setTab] = React.useState('upload');
  /* competition-rules popup: opened by the header-bar text link */
  const [rulesOpen, setRulesOpen] = React.useState(false);
  /* upload success takeover: the accepted upload swaps the body for the
   * success moment, then auto-advances to the Leaderboard tab */
  const [success, setSuccess] = React.useState(false);
  /* the hidden picker input stays mounted so the sticky CTA bar can tap
   * it while a file-row shows in the card */
  const fileRef = React.useRef(null);

  /* the leaderboard is public data — load on mount, refresh after a
   * successful upload; a failed fetch stays quiet (SimPanel FILES note
   * pattern, never fake numbers). */
  const loadLeaderboard = React.useCallback(() => {
    fetchLeaderboard()
      .then((r) => setEntries((r && r.entries) || []))
      .catch(() => setEntries(null));
  }, []);

  React.useEffect(() => { loadLeaderboard(); }, [loadLeaderboard]);

  /* the sheet is for signed-out visitors only — sign-in success closes it */
  React.useEffect(() => { if (signedIn) setSheetOpen(false); }, [signedIn]);

  /* Escape closes the rules popup while it is open (outside-tap + X too) */
  React.useEffect(() => {
    if (!rulesOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setRulesOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rulesOpen]);

  /* the success moment auto-advances to the Leaderboard tab; the timer
   * cleans up if the popup closes or success ends early */
  React.useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => {
      setSuccess(false);
      setTab('leaderboard');
    }, SUCCESS_MS);
    return () => clearTimeout(t);
  }, [success]);

  /* picked file: prefill capturedAt from its lastModified (editable) */
  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
    if (!f) return;
    setFile(f);
    setCapturedAt(toLocalInput(new Date(f.lastModified || Date.now())));
  };

  /* drop the pick — the widget returns to the dropzone state */
  const clearFile = () => {
    setFile(null);
    setCapturedAt('');
    setError(null);
  };

  /* CTA tap: the file picker signed-in, the sign-in sheet signed-out */
  const openPicker = () => {
    if (!signedIn) {
      setSheetOpen(true);
      return;
    }
    if (fileRef.current) fileRef.current.click();
  };

  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      /* client hash short-circuit — server recomputes regardless */
      let hash = null;
      try {
        hash = await sha256Hex(await file.arrayBuffer());
      } catch { hash = null; }
      await uploadCapture(file, {
        junction: junction.trim(), method,
        capturedAt: capturedAt
          ? new Date(capturedAt).toISOString() : null,
        hash,
      });
      /* the success card supersedes the old toast — the body takeover
       * carries the feedback, then the auto-advance moves to the board */
      setSuccess(true);
      setFile(null);
      setJunction('');
      setCapturedAt('');
      setError(null);
      loadLeaderboard();
    } catch (e) {
      setError(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };

  const rows = entries
    ? (showAll ? entries.slice(0, LB_LIMIT) : entries.slice(0, 10))
    : [];

  /* ---- redesign layout (design reference): brand head strip, scroll
   * body, sticky CTA bar; the sign-in sheet overlays the whole shell.
   * Each section is its own balanced builder so the tree stays readable. */

  const head = h('div', { className: 'dash-head capture-head' },
    h('span', { className: 'capture-brand' }, h(Icon, { name: 'video' })),
    h('h3', { className: 'capture-title' }, 'CAPTURE'),
    /* rules text link: right of the CAPTURE heading; opens the
     * competition-rules popup over the dash */
    h('button', { className: 'capture-rules-link',
      onClick: () => setRulesOpen(true) }, 'Rules'),
    h('button', { className: 'ghost',
      onClick: () => store.setView('discover') }, 'Close'));

  /* tab bar: Upload | Leaderboard, Upload first + default (visible at
   * every width — desktop gets the same tabs, not a stacked layout) */
  const tabs = h('div', { className: 'capture-tabs', role: 'tablist' },
    h('button', {
      className: 'capture-tab' + (tab === 'upload' ? ' on' : ''),
      role: 'tab', 'aria-selected': String(tab === 'upload'),
      onClick: () => setTab('upload'),
    }, 'Upload'),
    h('button', {
      className: 'capture-tab' + (tab === 'leaderboard' ? ' on' : ''),
      role: 'tab', 'aria-selected': String(tab === 'leaderboard'),
      onClick: () => setTab('leaderboard'),
    }, 'Leaderboard'));

  const uploadCard = h('div', { className: 'row-item capture-widget'
    + ' capture-pane-upload' },
    h('div', { className: 'row-line' },
      h('b', null, 'UPLOAD A CAPTURE'),
      h('span', { className: 'meta-inline' },
        'a clip or photo from the road — 1 point per accepted capture')),
    signedIn
      ? h('div', { className: 'capture-form' },
          /* signed-in user strip (initials avatar; no fake score — the
           * leaderboard below carries the real points) */
          h('div', { className: 'capture-user' },
            h('span', { className: 'capture-avatar' },
              initials(store.user.displayName || store.user.email)),
            h('span', { className: 'capture-user-who' },
              h('b', null, store.user.displayName || 'Contributor'),
              h('span', null, store.user.email || '')),
            h('span', { className: 'capture-points-chip' },
              '+1 point per accepted capture')),
          h('div', { className: 'capture-chips' },
            METHODS.map((m) => h('label', {
              key: m,
              className: 'capture-chip' + (method === m ? ' on' : ''),
            },
            h('input', {
              type: 'radio', name: 'capture-method', value: m,
              checked: method === m,
              onChange: () => setMethod(m),
            }),
            m))),
          h('input', {
            type: 'text', className: 'capture-input',
            placeholder: 'Junction / street name (required)',
            value: junction, maxLength: 200,
            onChange: (e) => setJunction(e.target.value),
          }),
          /* dropzone vs picked-file row; the picker input rides below
           * (sr-only, always mounted) so the CTA bar can tap it too */
          file
            ? h('div', { className: 'capture-file-row' },
                h('span', { className: 'capture-file-ico' },
                  h(Icon, { name: 'file' })),
                h('span', { className: 'capture-file-meta' },
                  h('b', null, file.name),
                  h('span', null,
                    Math.max(1, Math.round(file.size / 1024)) + ' KB')),
                h('button', { className: 'ghost',
                  onClick: clearFile }, 'Remove'))
            : h('div', { className: 'capture-drop',
                role: 'button', tabIndex: 0,
                onClick: openPicker,
                onKeyDown: (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openPicker();
                  }
                } },
              h(Icon, { name: 'upload', className: 'capture-drop-ico' }),
              h('b', null, 'Tap to select a traffic recording'),
              h('span', null,
                'video , recorded now or earlier — large clips '
                + 'upload best on Wi-Fi')),
          h('input', {
            ref: fileRef, type: 'file', className: 'capture-file',
            accept: 'video/*,image/*',
            onChange: onFile,
          }),
          h('label', { className: 'capture-field' },
            'CAPTURED AT',
            h('input', {
              type: 'datetime-local', className: 'capture-input',
              value: capturedAt,
              onChange: (e) => setCapturedAt(e.target.value),
            })),
          error ? h('div', { className: 'form-error' }, error) : null,
          h('button', {
            className: 'btn',
            onClick: upload,
            disabled: busy || !file || !junction.trim(),
          }, busy ? 'Uploading…' : 'Upload capture'))
      : h('div', { className: 'capture-form' },
          h('div', { className: 'hint' },
            'Sign in to upload — your Google account records the capture '
            + 'and scores the point. Any clip or photo you took can be '
            + 'picked here later.'),
          h('button', { className: 'btn',
            onClick: () => setSheetOpen(true) }, 'Sign in to upload')));

  const accItem = (c, i) => h('div', {
    key: c.title,
    className: 'capture-acc-item' + (accOpen === i ? ' on' : ''),
  },
  h('button', {
    className: 'capture-acc-head',
    onClick: () => setAccOpen((cur) => (cur === i ? null : i)),
    'aria-expanded': String(accOpen === i),
  },
  h('span', { className: 'capture-acc-glyph g' + i },
    h(Icon, { name: ACC_GLYPHS[i] })),
  h('span', { className: 'capture-acc-title' }, c.title),
  h(Icon, { name: 'chevron', className: 'capture-acc-chev' })),
  h('div', { className: 'capture-acc-body' },
    h('div', { className: 'capture-acc-inner' },
      h('div', { className: 'capture-acc-content' },
        h('p', { className: 'capture-acc-ask' }, c.ask),
        h('div', { className: 'capture-acc-tiles' },
          h('div', { className: 'capture-acc-tile' },
            h('b', null, 'WHY IT WORKS'),
            h('span', null, c.whyItWorks)),
          h('div', { className: 'capture-acc-tile' },
            h('b', null, 'HOW IT IS USED'),
            h('span', null, c.howItIsUsed)))))));

  const methodsSection = h(React.Fragment, null,
    h('div', { className: 'row-item capture-pane-upload' },
      h('div', { className: 'row-line' },
        h('b', null, 'CAPTURE METHODS'),
        h('span', { className: 'meta-inline' },
          'ultra-short recordings from the street — every method counts '
          + 'the same'))),
    h('div', { className: 'capture-acc capture-pane-upload' },
      GUIDE_METHODS.map((c, i) => accItem(c, i))));

  const leaderboardSection = h('div', { className: 'row-item'
    + ' capture-pane-leaderboard' },
    h('div', { className: 'row-line' },
      h('span', { className: 'capture-lb-glyph' },
        h(Icon, { name: 'trophy' })),
      h('b', null, 'LEADERBOARD'),
      h('span', { className: 'meta-inline' },
        'all-time · every accepted capture = 1 point')),
    h('div', { className: 'hint' }, LEADERBOARD_NOTE),
    entries === null
      ? h('div', { className: 'hint' }, 'leaderboard unavailable')
      : entries.length === 0
        ? h('div', { className: 'hint' },
          'no captures yet — be the first to earn a point')
        : h('div', { className: 'capture-lb' },
            rows.map((e) => h('div', { key: e.rank + e.name,
              className: 'capture-lb-row'
                + (e.rank === 1 ? ' capture-lb-top' : '') },
              h('span', { className: 'capture-rank' }, '#' + e.rank),
              h('span', { className: 'capture-avatar' },
                initials(e.name)),
              h('b', null, e.name),
              h('span', { className: 'meta-inline' },
                e.points + (e.points === 1 ? ' point' : ' points')))),
            entries.length > 10 && !showAll
              ? h('button', { className: 'ghost',
                onClick: () => setShowAll(true) },
              'show all (' + entries.length + ')')
              : null));

  /* upload success takeover: the whole body becomes the success moment
   * ("Upload Successful" instead of the form), then the auto-advance
   * moves to the leaderboard tab */
  const successCard = h('div', { className: 'capture-success' },
    h('span', { className: 'capture-success-glyph' },
      h(Icon, { name: 'check' })),
    h('b', { className: 'capture-success-title' }, 'Upload Successful'),
    h('span', { className: 'capture-success-sub' },
      '1 point on the leaderboard — taking you there…'));

  /* success takeover: the accepted upload swaps the WHOLE body for the
   * success moment, then the auto-advance lands on the leaderboard */
  const bodyKids = success
    ? [successCard]
    : [uploadCard, methodsSection, leaderboardSection];

  const sheet = sheetOpen
    ? h('div', { className: 'capture-veil',
        onClick: (ev) => {
          if (ev.target === ev.currentTarget) setSheetOpen(false);
        } },
      h('div', { className: 'capture-sheet' },
        h('button', { className: 'capture-sheet-x',
          onClick: () => setSheetOpen(false), 'aria-label': 'Close' },
          h(Icon, { name: 'x' })),
        h('span', { className: 'capture-sheet-glyph' },
          h(Icon, { name: 'shield' })),
        h('h4', { className: 'capture-sheet-title' }, 'Sign in to CAPTURE'),
        h('p', { className: 'hint' },
          'Your Google account records the capture and scores the '
          + 'leaderboard point.'),
        h('button', { className: 'gbtn',
          onClick: () => { store.signIn(); } },
        G_MARK, h('span', null, 'Continue with Google')),
        h('p', { className: 'capture-sheet-note' },
          'Clips recorded on the road can be uploaded later on Wi-Fi.')))
    : null;

  /* competition-rules popup: centered dialog over the dash; only the
   * body scrolls (the copy is long — eight numbered sections) */
  const rulesPop = rulesOpen
    ? h('div', { className: 'capture-rules-veil',
        onClick: (ev) => {
          if (ev.target === ev.currentTarget) setRulesOpen(false);
        } },
      h('div', { className: 'capture-rules-pop', role: 'dialog',
        'aria-modal': 'true', 'aria-label': COMPETITION_RULES.title },
        h('div', { className: 'capture-rules-head' },
          h('b', { className: 'capture-rules-title' },
            COMPETITION_RULES.title),
          h('button', { className: 'capture-rules-x',
            onClick: () => setRulesOpen(false),
            'aria-label': 'Close' }, h(Icon, { name: 'x' }))),
        h('div', { className: 'capture-rules-body' },
          COMPETITION_RULES.sections.map((sec) => h('section',
            { key: sec.heading, className: 'capture-rules-sec' },
            h('h4', { className: 'capture-rules-h' }, sec.heading),
            sec.blocks.map((b, bi) => b.ul
              ? h('ul', { key: bi, className: 'capture-rules-ul' },
                  b.ul.map((li, li2) => h('li', { key: li2 }, mdRuns(li))))
              : h('p', { key: bi, className: 'capture-rules-p' },
                  mdRuns(b.p))))))))
    : null;

  return h('div', { className: 'dash-veil' },
    h('div', { className: 'dash capture-dash', 'data-tab': tab }, head,
      tabs,
      h('div', { className: 'capture-body' }, bodyKids),
      sheet, rulesPop));
}
