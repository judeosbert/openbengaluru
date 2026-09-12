/* Port of test_app.js tests 13-17 (TrafficSimEngine against the real
 * Balagere stream payload), test_mock.py test 11 (frame-edge safety via the
 * interp_edge harness command -> direct engine calls here), and phase2/
 * test_phase2.js tests 1-2 (entry-carried frames / frameCount). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TrafficSimEngine } from '../src/lib/engine.js';
import { readStreamPayload, frameIds } from './helpers/streamPayload.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const NF = 900;
const STREAM = readStreamPayload('balagere-t-junction');

// test_app.js 13 --------------------------------------------------------------
it('engine exists', () => {
  const src = fs.readFileSync(path.join(PLAYER_ROOT, 'src', 'lib', 'engine.js'), 'utf8');
  expect(src, 'src/lib/engine.js: no `class TrafficSimEngine` found')
    .toMatch(/class\s+TrafficSimEngine/);
  expect(typeof TrafficSimEngine).toBe('function');
  const eng = new TrafficSimEngine(STREAM);
  for (const m of ['getVehiclesAtTime', 'getStatsAt', 'clearCache']) {
    expect(typeof eng[m], 'TrafficSimEngine missing method ' + m).toBe('function');
  }
});

// test_app.js 14 --------------------------------------------------------------
it('engine vehicle sample', () => {
  const eng = new TrafficSimEngine(STREAM);
  for (const key of ['today', 'proposed']) {
    const v0 = eng.getVehiclesAtTime(0, key);
    expect(Array.isArray(v0), key + ': getVehiclesAtTime(0) not an array').toBe(true);
    const ids0 = frameIds(STREAM, key, 0);
    expect(v0.length,
      `${key}: frame 0 id mismatch (engine ${v0.length} vs stream ${ids0.size})`)
      .toBe(ids0.size);
    const v45 = eng.getVehiclesAtTime(45, key);
    const ids45 = frameIds(STREAM, key, 45);
    expect(v45.length,
      `${key}: frame 45 id mismatch (engine ${v45.length} vs stream ${ids45.size})`)
      .toBe(ids45.size);
    expect(v45.every((r) => ids45.has(r[0])), key + ': frame 45 unknown ids returned')
      .toBe(true);
    const vEnd = eng.getVehiclesAtTime(NF - 1, key);
    expect(vEnd.length > 0, key + ': frame NF-1 must be non-empty').toBe(true);
  }
});

// test_app.js 15 --------------------------------------------------------------
it('engine interpolation exclusivity', () => {
  const eng = new TrafficSimEngine(STREAM);
  const at = (t) => new Map(eng.getVehiclesAtTime(t, 'today').map((r) => [r[0], r]));
  const a = at(45), b = at(46), mid = at(45.5);
  let proven = 0;
  for (const [id, r0] of a) {
    const r1 = b.get(id);
    if (!r1) continue;
    const rm = mid.get(id);
    expect(rm, `vehicle ${id} missing at t=45.5 though present in both frames`)
      .toBeTruthy();
    for (const k of [1, 2, 3]) {                    // x, y, angle
      const lo = Math.min(r0[k], r1[k]), hi = Math.max(r0[k], r1[k]);
      if (lo === hi) continue;
      expect(rm[k] > lo && rm[k] < hi,
        `id ${id} attr ${k}: ${rm[k]} not strictly between ${lo} and ${hi}`).toBe(true);
      proven++;
    }
  }
  expect(proven > 0, 'no attribute provably interpolated at t=45.5').toBe(true);
});

// test_app.js 16 --------------------------------------------------------------
it('engine return is copy', () => {
  const eng = new TrafficSimEngine(STREAM);
  const first = eng.getVehiclesAtTime(120, 'today');
  expect(first.length > 0, 'frame 120 unexpectedly empty').toBe(true);
  const origX = first[0][1];
  first[0][1] = -99999;                              // mutate row
  first.push(['bogus']);                             // mutate array
  const second = eng.getVehiclesAtTime(120, 'today');
  expect(second.length === 0 || second[second.length - 1][0] !== 'bogus',
    'engine returned a shared array (push leaked across calls)').toBe(true);
  expect(second.length, 'length changed after caller mutation')
    .toBe(eng.getVehiclesAtTime(120, 'today').length);
  expect(second[0][1] === origX || second[0][0] !== first[0][0],
    'engine returned shared rows (in-place write leaked across calls)').toBe(true);
});

// test_app.js 17 --------------------------------------------------------------
it('engine stats shape', () => {
  const eng = new TrafficSimEngine(STREAM);
  for (const key of ['today', 'proposed']) {
    for (const t of [0, 100, NF - 1]) {
      const s = eng.getStatsAt(t, key);
      expect(Array.isArray(s) && s.length === 5,
        `${key}@${t}: stats must be [through,moving,stopped,queued,gridlock]`).toBe(true);
      expect(s.every((v) => Number.isInteger(v) && v >= 0),
        `${key}@${t}: stats must be non-negative ints, got ${JSON.stringify(s)}`).toBe(true);
    }
  }
  eng.clearCache();
  const s = eng.getStatsAt(100, 'today');
  expect(s.length, 'stats broken after clearCache()').toBe(5);
});

// test_mock.py 11 (harness interp_edge -> direct engine calls) -----------------
it('overlay zero frame safe', () => {
  const eng = new TrafficSimEngine(STREAM);
  const nf = STREAM.nFrames;
  const len = (t) => {
    const v = eng.getVehiclesAtTime(t, 'today');
    expect(Array.isArray(v), `getVehiclesAtTime did not return an array at t=${t}`)
      .toBe(true);
    return v.length;
  };
  expect(len(0), 'frame 0 is empty in the real stream').toBe(0);
  expect(len(nf - 1), 'frame NF-1 must yield vehicles').toBeGreaterThan(0);
  expect(len(nf - 0.1), 't=NF-0.1 must interpolate safely').toBeGreaterThan(0);
  expect(len(nf + 51), 't>NF-1 must clamp, not crash').toBeGreaterThan(0);
  expect(len(-3), 'negative t must clamp to frame 0').toBe(0);
});

// phase2/test_phase2.js 1 ------------------------------------------------------
it('engine decodes frames from entry.scenarios', () => {
  const entryWithFrames = {
    id: 'test-sim',
    nFrames: 900,
    scenarios: {
      today: {
        frames: 'AAAAAQAAAAAAAAAA',  // minimal valid base64 BLGR (1 frame, 0 vehicles)
        stats: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',  // placeholder
        lanes: [{ p: [[0, 0], [100, 0]], w: 3.2 }],
      },
    },
  };
  const eng = new TrafficSimEngine(null, entryWithFrames, 'test-sim');
  const vehicles = eng.getVehiclesAtTime(0, 'today');
  expect(Array.isArray(vehicles),
    'getVehiclesAtTime did not return array from entry frames').toBe(true);
});

// phase2/test_phase2.js 2 ------------------------------------------------------
it('frameCount reads entry.nFrames', () => {
  const entryWithFrames = {
    id: 'test-sim',
    nFrames: 900,
    scenarios: {
      today: {
        frames: 'AAAAAQAAAAAAAAAA',
        stats: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        lanes: [{ p: [[0, 0], [100, 0]], w: 3.2 }],
      },
    },
  };
  const eng = new TrafficSimEngine(null, entryWithFrames, 'test-sim');
  expect(eng.frameCount('today')).toBe(900);
});
