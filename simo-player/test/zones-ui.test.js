/* ZonesAndPins draws no zone polygon: the colored rectangle around each
 * catalog entry (e.g. the green box on a fresh submission) was removed —
 * only the zoom-dependent badge/pin markers remain, still anchored at the
 * zonePoly centroid. Source-pinned like test/html.test.js pins TrafficMap
 * (the node vitest env has no DOM to render Leaflet into). */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const SRC = path.join(PLAYER_ROOT, 'src', 'map', 'ZonesAndPins.js');

it('ZonesAndPins draws no zone polygon', () => {
  const s = fs.readFileSync(SRC, 'utf8');
  expect(s, 'zone polygon rendering was removed — no L.polygon in ZonesAndPins')
    .not.toMatch(/L\.polygon/);
  expect(s, 'badge must still anchor at the zonePoly centroid')
    .toMatch(/zonePoly\.reduce/);
});
