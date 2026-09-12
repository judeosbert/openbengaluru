/* Port of test_mock.py test 5 — every catalog entry's packed stats blob must
 * decode to nFrames x 5 u16 rows, with non-decreasing `through`, all values
 * in u16 range, and queued peaks strictly below the entry's demand. */
import { describe, it, expect } from 'vitest';
import { readDataConsts, decodeStats } from './helpers/dataConsts.js';

it('stats monotone', () => {
  const D = readDataConsts();
  for (const e of D.CATALOG) {
    const nf = e.nFrames;
    for (const [skey, sc] of Object.entries(e.scenarios)) {
      expect(sc, `${e.id}/${skey}: no stats blob`).toHaveProperty('stats');
      const rows = decodeStats(sc.stats, nf);
      const through = rows.map((r) => r[0]);
      expect(through.every((v, i) => i === 0 || through[i - 1] <= v),
        `${e.id}/${skey}: through not non-decreasing`).toBe(true);
      const flat = rows.flat();
      expect(flat.every((v) => Number.isInteger(v) && v >= 0 && v <= 65535),
        `${e.id}/${skey}: stats values out of u16 range`).toBe(true);
      const qmax = Math.max(...rows.map((r) => r[3]));
      expect(qmax, `${e.id}/${skey}: queued ${qmax} !< demand ${e.demand}`)
        .toBeLessThan(e.demand);
    }
  }
});
