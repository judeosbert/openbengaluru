/* Sim panel + A/B scenario toggle. Ported verbatim from app.js. On
 * <=900px viewports the sheet CSS becomes a bottom sheet: the grip/title
 * strip is fixed outside the scroll, the body (.sheet-body) scrolls, and
 * content order puts Run on top, then sliders, then numbers, then FILES.
 * It collapses to the 56px title strip when the sim runs — minimized,
 * scrolling is off and a swipe (or tap) on the strip re-expands. */
import React from 'react';
import { engineFor, scenarioGeoOf, fmtStat } from '../map/overlay.js';
import { serverAvailable, DATA_SOURCE_LABELS } from '../lib/submit.js';

const h = React.createElement;

/* collapsed strip height — mirrors the CSS `translateY(calc(100% - 56px))` */
const STRIP_PX = 56;

/* FILES section rows, keyed to the fixed stored names the player server
 * persists (storage.js FILE_NAMES). Proposed Network needs an approved
 * wizard submission carrying proposed.net.xml — until then its row is
 * disabled with a tooltip. */
const FILE_ROWS = [
  { label: 'Demand File', file: 'demand.rou.xml' },
  { label: 'Current Network', file: 'today.net.xml' },
  { label: 'Proposed Network', file: 'proposed.net.xml' },
];

/* Source files stored by the player server for this entry (POST
 * /api/simulate persists the wizard's raw XMLs; GET /api/files/:id lists
 * them). Self-contained: fetch failure, a server without the route, or
 * file:// all degrade to an empty list — the section just stays hidden. */
function useSourceFiles(entry) {
  const id = entry && entry.id;
  const [files, setFiles] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    setFiles(null);
    if (!id || !serverAvailable(window.location)) return undefined;
    fetch('/api/files/' + encodeURIComponent(id))
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => { if (live) setFiles(Array.isArray(list) ? list : []); })
      .catch(() => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [id]);
  return files;
}

export const HUD_LABELS = ['THROUGH', 'MOVING', 'STOPPED', 'QUEUED OUTSIDE', 'GRIDLOCKS'];

export function SimScenarioToggle({ value, onChange, scenarios }) {
  const keys = ['today', 'proposed'].filter((k) => scenarios && scenarios[k]);
  return h('div', { className: 'scen-toggle' },
    keys.map((k) => h('button', {
      key: k,
      className: k === value ? '' : 'ghost',
      onClick: () => onChange(k),
    }, (scenarios[k].title || k).toUpperCase())));
}

export function SimPanel({ entry, scenKey, simT, running, speed,
  streamError, onScenario, onRun, onStop, onScrub, onSpeed, onClose }) {
  const eng = React.useMemo(() => engineFor(entry), [entry]);
  const srcFiles = useSourceFiles(entry);
  const scenario = entry.scenarios && entry.scenarios[scenKey]
    ? entry.scenarios[scenKey] : null;
  /* frames gate every number: until the scenario's stream arrives there is
   * nothing honest to show, so the stats block is replaced by a loading
   * note (or the failure note after a stream error) — no fake zeros
   * dressed as data. API entries carry real inline stats but still wait
   * for frames: uniform, always honest. */
  const loaded = !!(scenario && scenario.frames);
  const stats = loaded ? eng.getStatsAt(simT, scenKey) : null;
  const geo = scenarioGeoOf(entry, scenKey);
  const nf = entry.nFrames || 900;
  const ss = Math.floor(Math.max(0, Math.min(nf - 1, simT)));
  const clock = String(Math.floor(ss / 60)).padStart(2, '0') + ':'
    + String(ss % 60).padStart(2, '0');
  const hasBoth = !!(entry.scenarios && entry.scenarios.today
    && entry.scenarios.proposed);
  const statColors = loaded ? ['var(--green)', 'var(--ink)', 'var(--amber)',
    'var(--red)', stats[4] ? 'var(--red)' : 'var(--ink3)'] : null;

  /* bottom-sheet state (only styled <=900px; the classes are inert on
   * desktop where the media block does not exist) */
  const [collapsed, setCollapsed] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const sheetRef = React.useRef(null);
  const dragRef = React.useRef(null);

  /* a newly selected sim always opens expanded */
  React.useEffect(() => {
    setCollapsed(false);
  }, [entry.id]);

  const onPointerDown = (e) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const rect = sheet.getBoundingClientRect();
    /* drag handle = the top strip only; below it, scrub/speed sliders and
     * body scroll keep working */
    if (e.clientY - rect.top > STRIP_PX) return;
    if (e.target && e.target.closest
      && e.target.closest('button,a,input')) return;
    dragRef.current = {
      startY: e.clientY,
      base: collapsed ? rect.height - STRIP_PX : 0,
      maxOff: rect.height - STRIP_PX,
    };
    setDragging(true);
    sheet.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    const sheet = sheetRef.current;
    if (!d || !sheet) return;
    const off = Math.max(0, Math.min(d.maxOff, d.base + e.clientY - d.startY));
    sheet.style.transform = 'translateY(' + off + 'px)';
  };
  const onPointerUp = (e) => {
    const d = dragRef.current;
    const sheet = sheetRef.current;
    if (!d || !sheet) return;
    const dy = e.clientY - d.startY;
    dragRef.current = null;
    setDragging(false);
    /* clear the inline transform in the same commit as the class change so
     * the CSS transition animates from the dragged position */
    sheet.style.transform = '';
    if ((Math.abs(dy) < 6 && collapsed) || dy < -40) setCollapsed(false);
    else if (dy > 40) setCollapsed(true);
  };

  return h('div', {
    className: 'sheet' + (collapsed ? ' sheet-collapsed' : '') + (dragging ? ' sheet-drag' : ''),
    ref: sheetRef,
    onPointerDown, onPointerMove, onPointerUp,
  },
    /* the strip (grip + ✕ + title) stays OUTSIDE the scroll — only the
     * body scrolls (<=900px), so the strip is always visible */
    h('div', { className: 'sheet-grip' }),
    h('button', { className: 'ghost closex', onClick: onClose }, '✕'),
    h('h2', null, entry.title),
    h('div', { className: 'sheet-body' },
      h('div', { className: 'by' },
        'by ', h('b', null, entry.author), ' · added ', entry.addedAt,
        geo && geo.sub ? h('span', null, ' · ', geo.sub) : null),
      entry.desc ? h('div', { className: 'by' }, entry.desc) : null,
      entry.dataSource ? h('div', { className: 'by' },
        'DATA SOURCE · ',
        h('b', null, DATA_SOURCE_LABELS[entry.dataSource] || entry.dataSource),
        entry.sourceUrl ? h('a', {
          className: 'filelink', href: entry.sourceUrl,
          target: '_blank', rel: 'noreferrer',
        }, ' · source link') : null) : null,
      entry.review
        ? h('div', { className: 'status-chip reviewchip ' + entry.review },
          'REVIEW · ' + String(entry.review).toUpperCase())
        : null,
      srcFiles && srcFiles.length ? h('div', { className: 'fld files' },
        h('label', null, 'FILES'),
        h('div', { className: 'filelist' },
          FILE_ROWS.map((r) => {
            const stored = srcFiles.includes(r.file);
            return h('div', { key: r.file, className: 'filerow' },
              h('b', null, r.label),
              stored
                ? h('a', {
                  className: 'filelink',
                  href: '/api/files/' + encodeURIComponent(entry.id) + '/'
                    + encodeURIComponent(r.file),
                  download: r.file,
                }, r.file)
                : h('span', {
                  className: 'filelink disabled',
                  title: 'No approved submissions yet',
                }, r.file));
          }))) : null,
      h('div', { className: 'statgrid' },
        h('div', null, h('b', null, 'DEMAND /HR'),
          h('span', { className: 'num' }, fmtStat(entry.demand))),
        h('div', null, h('b', null, 'PEAK SERVED'),
          h('span', { className: 'num' }, fmtStat(entry.peakServed)))),
      hasBoth ? h(SimScenarioToggle, {
        value: scenKey, onChange: onScenario, scenarios: entry.scenarios,
      }) : null,
      streamError
        ? h('div', { key: 'serr', className: 'reject' },
          'simulation data failed to load — close and reopen to retry')
        : !loaded
          ? h('div', { key: 'sload', className: 'hint' },
            'loading simulation data…')
          : h('div', { key: 'stats', className: 'statgrid' },
            HUD_LABELS.map((lab, k) => h('div', { key: lab },
              h('b', null, lab),
              h('span', { className: 'num', style: { color: statColors[k] } },
                fmtStat(stats[k])))),
            h('div', null, h('b', null, 'SIM TIME'),
              h('span', { className: 'num' }, clock))),
      h('div', { className: 'fld' },
        h('label', null, 'SCRUB'),
        h('input', {
          type: 'range', min: 0, max: nf - 1, step: 0.1,
          value: Math.min(simT, nf - 1),
          onInput: (ev) => onScrub(parseFloat(ev.target.value)),
        }),
        h('span', { className: 'val' }, clock)),
      h('div', { className: 'fld' },
        h('label', null, 'SPEED'),
        h('input', {
          type: 'range', min: 1, max: 90, step: 1, value: speed,
          onInput: (ev) => onSpeed(parseInt(ev.target.value, 10) || 1),
        }),
        h('span', { className: 'val' }, speed + '×')),
      h('div', { className: 'actions' },
        running
          ? h('button', { className: 'ghost', onClick: onStop }, 'Stop')
          : h('button', {
            onClick: () => { setCollapsed(true); onRun(entry.id); },
          }, 'Run on Map'))));
}
