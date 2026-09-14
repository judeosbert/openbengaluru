/* The PRELOADED catalog pins/badges layer is fully removed: no markers for
 * the base-bundle (generated) entries. Only review-flow ACTIVE entries
 * (apiStream-stamped by the boot merge) get map pins — via the async,
 * batched ActivePins layer. Source-pinned like test/html.test.js pins
 * TrafficMap (the node vitest env has no DOM to render Leaflet into). */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const SRC = path.join(PLAYER_ROOT, 'src', 'map', 'ZonesAndPins.js');
const TM = path.join(PLAYER_ROOT, 'src', 'map', 'TrafficMap.js');

it('no preloaded sim markers: ZonesAndPins is gone from the map', () => {
  const tm = fs.readFileSync(TM, 'utf8');
  expect(tm, 'TrafficMap must not import ZonesAndPins')
    .not.toMatch(/ZonesAndPins/);
  expect(fs.existsSync(SRC),
    'src/map/ZonesAndPins.js should be deleted with the layer').toBe(false);
});

it('ACTIVE entries are pinned by the async batched ActivePins layer', () => {
  const tm = fs.readFileSync(TM, 'utf8');
  expect(tm, 'TrafficMap must render ActivePins').toMatch(/ActivePins/);
  expect(tm, 'the layer must be fed the merged catalog')
    .toMatch(/store\.catalog/);
});
