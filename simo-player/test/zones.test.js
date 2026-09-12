/* Port of test_mock.py test 6 — zones of the 8 synthetic OTHER_SIMS entries
 * must be plausible: inside Bengaluru, non-degenerate, non-self-intersecting,
 * and ~40 m squares (except the one entry allowed an oversized zone). */
import { describe, it, expect } from 'vitest';
import { readDataConsts } from './helpers/dataConsts.js';

const SILK_BOARD_ID = 'silk-board-peak-baseline';  // only entry allowed an oversized zone

function orient(p, q, r) {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
}

/* Strict crossing test (shared endpoints / collinear touches ignored). */
function segsCross(a, b, c, d) {
  const d1 = orient(c, d, a), d2 = orient(c, d, b);
  const d3 = orient(a, b, c), d4 = orient(a, b, d);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0)
    && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

it('zones plausible', () => {
  const others = readDataConsts().OTHER_SIMS;
  expect(others.length, `need 8 fake sims, got ${others.length}`).toBe(8);
  for (const e of others) {
    const poly = e.zonePoly;
    expect(poly.length >= 3, `${e.id}: zone < 3 pts`).toBe(true);
    for (const [lat, lng] of poly) {
      expect(lat >= 12.80 && lat <= 13.05, `${e.id}: lat ${lat} out of range`).toBe(true);
      expect(lng >= 77.50 && lng <= 77.85, `${e.id}: lng ${lng} out of range`).toBe(true);
    }
    const area = 0.5 * Math.abs(poly.reduce((s, p, i) => {
      const q = poly[(i + 1) % poly.length];
      return s + (p[1] * q[0] - q[1] * p[0]);
    }, 0));
    expect(area > 0, `${e.id}: degenerate zone polygon`).toBe(true);
    const pts = poly.map(([lat, lng]) => [lng, lat]);
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (j === i + 1 || (i === 0 && j === n - 1)) continue;  // adjacent edges share a vertex
        expect(segsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]),
          `${e.id}: zone self-intersects at edges ${i},${j}`).toBe(false);
      }
    }
    if (e.id !== SILK_BOARD_ID) {
      const dlat = Math.max(...poly.map((p) => p[0])) - Math.min(...poly.map((p) => p[0]));
      const dlng = Math.max(...poly.map((p) => p[1])) - Math.min(...poly.map((p) => p[1]));
      expect(dlat < 0.0006,
        `${e.id}: zone ${Math.round(dlat * 111e3)} m tall (> ~60 m safety bound)`).toBe(true);
      expect(dlng < 0.0006,
        `${e.id}: zone ${Math.round(dlng * 108e3)} m wide (> ~60 m safety bound)`).toBe(true);
    }
  }
});
