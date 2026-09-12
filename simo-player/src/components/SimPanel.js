/* Sim panel + A/B scenario toggle. Ported verbatim from app.js. */
import React from 'react';
import { engineFor, scenarioGeoOf, fmtStat } from '../map/overlay.js';

const h = React.createElement;

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
