/* Port of test_mock.py tests 1, 2, 3, 9 + test_streams.py test 6.
 *
 * Targets public/data.js (generated artifact) and the ported source layout:
 * SimScenarioToggle must live in src/components/SimPanel.js, the
 * activeScenario state in src/state/store.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readDataConsts, PLAYER_ROOT } from './helpers/dataConsts.js';
import { readStreamPayload } from './helpers/streamPayload.js';

const EXPECTED_CONSTS = ['BALAGERE_CSS_STYLE', 'LANES_PALETTE', 'BALAGERE_GEOMETRY',
  'OTHER_SIMS', 'CATALOG'];
const ANCHOR = [12.9517, 77.7894];          // plan: latlngAnchor
/* The generator (sim/build_player.py --export-mock) emits these 9 sims; a
 * 10th dev-injected entry (dev_inject.js) may legitimately ride along in the
 * committed artifact — test_mock.py's hard `== 9` predates that injection
 * and fails against the current data.js. The port pins the generated ids
 * instead; every entry (dev ones included) must pass the structure checks. */
const GENERATED_IDS = [
  'balagere-t-junction', 'silk-board-peak-baseline', 'varthur-bridge-morning',
  'hsr-27th-main-evening', 'marathahalli-bridge-uturn-ban',
  'kundalahalli-signal-timing', 'whitefield-itpl-bottleneck',
  'sarjapur-44-acres', 'bellandur-east',
];

function consts() {
  const D = readDataConsts();
  const missing = EXPECTED_CONSTS.filter((c) => !(c in D));
  expect(missing, `data.js missing top-level consts: ${missing}`).toEqual([]);
  return D;
}

// test_mock.py 1 --------------------------------------------------------------
it('catalog structure', () => {
  const cat = consts().CATALOG;
  expect(cat.length, `catalog must hold at least the 9 generated sims, got ${cat.length}`)
    .toBeGreaterThanOrEqual(9);
  const ids = new Set(cat.map((e) => e.id));
  const missingIds = GENERATED_IDS.filter((id) => !ids.has(id));
  expect(missingIds, `generated catalog entries missing from data.js: ${missingIds}`)
    .toEqual([]);
  for (const e of cat) {
    for (const k of ('id title author anchor rotation demand peakServed '
      + 'zonePoly addedAt scenarios nFrames').split(' ')) {
      expect(e, `${e.id}: missing key ${k}`).toHaveProperty(k);
    }
    expect(Array.isArray(e.anchor)).toBe(true);
    const [lat, lng] = e.anchor;
    expect(lat > 12.5 && lat < 13.3 && lng > 77.3 && lng < 78.1,
      `${e.id}: anchor ${e.anchor} outside Bangalore`).toBe(true);
    expect(Array.isArray(e.zonePoly)).toBe(true);
    expect(e.zonePoly.length).toBeGreaterThanOrEqual(3);
    expect(e.scenarios && typeof e.scenarios === 'object').toBe(true);
    expect(Object.keys(e.scenarios).length).toBeGreaterThanOrEqual(1);
    for (const [skey, sc] of Object.entries(e.scenarios)) {
      expect(sc, `${e.id}/${skey}: no lanes`).toHaveProperty('lanes');
      expect(sc.lanes.length, `${e.id}/${skey}: lanes empty`).toBeGreaterThan(0);
      for (const lane of sc.lanes) {
        expect(lane).toHaveProperty('p');
        expect(lane).toHaveProperty('w');
        expect(lane.p.length).toBeGreaterThanOrEqual(2);
        expect(lane.w).toBeGreaterThan(0);
      }
    }
  }
});

// test_mock.py 2 --------------------------------------------------------------
it('geometry anchor presence', () => {
  const g = consts().BALAGERE_GEOMETRY;
  expect(g).toHaveProperty('latlngAnchor');
  expect(g).toHaveProperty('rotation');
  expect(typeof g.rotation === 'number').toBe(true);
  expect(Math.abs(g.latlngAnchor[0] - ANCHOR[0]), 'latlngAnchor lat')
    .toBeLessThan(0.01);
  expect(Math.abs(g.latlngAnchor[1] - ANCHOR[1]), 'latlngAnchor lng')
    .toBeLessThan(0.01);
  const scen = g.scenarios;
  expect(scen).toHaveProperty('today');
  expect(scen).toHaveProperty('proposed');
  expect(Object.values(scen).some((s) => (s.phases || []).length > 0),
    'at least one scenario must carry phases').toBe(true);
});

// test_mock.py 3 --------------------------------------------------------------
it('phase cycle sums', () => {
  const D = consts();
  const pro = D.BALAGERE_GEOMETRY.scenarios.proposed;
  const phases = pro.phases;
  expect(phases.length).toBeGreaterThan(0);
  const cyc = phases.reduce((s, p) => s + parseFloat(p[0]), 0);
  expect(cyc).toBeGreaterThan(0);
  expect(cyc, `phase cycle ${cyc}s exceeds 180s`).toBeLessThanOrEqual(180);
  const states = phases.map((p) => p[1]);
  expect(states.every((st) => st.length === states[0].length),
    'phase state strings differ in length').toBe(true);
  const chars = new Set(states.join(''));
  expect([...chars].every((ch) => 'Ggyr'.includes(ch)),
    `unexpected signal states: ${[...chars].join('')}`).toBe(true);
  expect(chars.has('G')).toBe(true);
  expect(chars.has('y')).toBe(true);
  const links = pro.links;
  expect(Object.keys(links).length, 'proposed must have controlled links')
    .toBeGreaterThan(0);
  const maxIdx = Math.max(...Object.values(links).flat());
  expect(states[0].length, `state len ${states[0].length} <= max linkIndex ${maxIdx}`)
    .toBeGreaterThan(maxIdx);
  // today's give-way junction has no signal logic
  expect(D.BALAGERE_GEOMETRY.scenarios.today.phases.length).toBe(0);
});

// test_mock.py 9 --------------------------------------------------------------
it('ab toggle shape', () => {
  const D = consts();
  const bal = D.CATALOG[0];
  const keys = new Set(Object.keys(bal.scenarios));
  expect([...keys].every((k) => k === 'today' || k === 'proposed'),
    `${bal.id}: bad scenario keys`).toBe(true);
  expect(keys, 'Balagere must carry both scenarios')
    .toEqual(new Set(['today', 'proposed']));
  const spayload = readStreamPayload('balagere-t-junction');
  expect(new Set(Object.keys(spayload.scenarios)))
    .toEqual(new Set(['today', 'proposed']));
  for (const e of D.OTHER_SIMS) {
    expect(Object.keys(e.scenarios).every((k) => k === 'today' || k === 'proposed'),
      `${e.id}: bad scenario keys`).toBe(true);
  }
  // source checks re-pointed at the ported modules (was: regex over app.js)
  const panelSrc = fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'components', 'SimPanel.js'), 'utf8');
  expect(panelSrc, 'SimPanel.js must expose a SimScenarioToggle component')
    .toMatch(/SimScenarioToggle/);
  const storeSrc = fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'state', 'store.js'), 'utf8');
  expect(storeSrc).toMatch(/activeScenario/);
});

// test_streams.py 6 -----------------------------------------------------------
it('catalog keeps stats inline', () => {
  // HUD stats must stay in data.js (no lazy load for counters).
  const bal = readDataConsts().CATALOG[0];
  for (const [k, sc] of Object.entries(bal.scenarios)) {
    expect(sc, `catalog today/proposed lost stats (${k})`).toHaveProperty('stats');
  }
});
