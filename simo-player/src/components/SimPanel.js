/* Sim panel + A/B scenario toggle. Ported verbatim from app.js. */
import React from 'react';
import { engineFor, scenarioGeoOf, fmtStat } from '../map/overlay.js';
import { serverAvailable } from '../lib/submit.js';

const h = React.createElement;

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
  onScenario, onRun, onStop, onScrub, onSpeed, onClose }) {
  const eng = React.useMemo(() => engineFor(entry), [entry]);
  const srcFiles = useSourceFiles(entry);
  const stats = eng.getStatsAt(simT, scenKey);
  const geo = scenarioGeoOf(entry, scenKey);
  const nf = entry.nFrames || 900;
  const ss = Math.floor(Math.max(0, Math.min(nf - 1, simT)));
  const clock = String(Math.floor(ss / 60)).padStart(2, '0') + ':'
    + String(ss % 60).padStart(2, '0');
  const hasBoth = !!(entry.scenarios && entry.scenarios.today
    && entry.scenarios.proposed);
  const statColors = ['var(--green)', 'var(--ink)', 'var(--amber)',
    'var(--red)', stats[4] ? 'var(--red)' : 'var(--ink3)'];

  return h('div', { className: 'sheet' },
    h('button', { className: 'ghost closex', onClick: onClose }, '✕'),
    h('h2', null, entry.title),
    h('div', { className: 'by' },
      'by ', h('b', null, entry.author), ' · added ', entry.addedAt,
      geo && geo.sub ? h('span', null, ' · ', geo.sub) : null),
    entry.desc ? h('div', { className: 'by' }, entry.desc) : null,
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
    h('div', { className: 'statgrid' },
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
        : h('button', { onClick: () => onRun(entry.id) }, 'Run on Map')));
}
