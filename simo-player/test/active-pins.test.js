/* Active-pin contract: review-flow ACTIVE entries (apiStream-stamped by
 * the boot merge of GET /api/catalog) get map pins; the preloaded
 * base-bundle entries stay marker-free. Pins are added ASYNCHRONOUSLY in
 * BATCHES on page load. The pure selection/chunking helpers live in
 * src/lib/pins.js (DOM-free, node-testable); the Leaflet layer
 * (src/map/ActivePins.js) is source-pinned (html.test.js precedent). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pinEntries, batches } from '../src/lib/pins.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const active = (over = {}) => ({
  id: 'kundalahalli-1', title: 'Kundalahalli', author: 'qa',
  anchor: [12.94, 77.72], apiStream: true, ...over,
});

describe('pinEntries (pure selection)', () => {
  it('keeps only apiStream (active) entries with a valid anchor', () => {
    const catalog = [
      active(),
      active({ id: 'gen-base', apiStream: undefined }),   // preloaded base
      active({ id: 'no-anchor', anchor: null }),          // odd entry
      active({ id: 'bad-anchor', anchor: [12.9] }),
      active({ id: 'nan-anchor', anchor: [NaN, 77.7] }),
    ];
    expect(pinEntries(catalog).map((e) => e.id)).toEqual(['kundalahalli-1']);
  });

  it('tolerates junk catalog members and non-arrays', () => {
    expect(pinEntries([null, 7, {}, { anchor: [1, 2] }])).toEqual([]);
    expect(pinEntries(undefined)).toEqual([]);
  });
});

describe('batches (pure chunking)', () => {
  it('chunks 0..n into groups of size, last takes the remainder', () => {
    expect(batches(7, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(batches(6, 3)).toEqual([[0, 1, 2], [3, 4, 5]]);
    expect(batches(2, 10)).toEqual([[0, 1]]);
    expect(batches(0, 3)).toEqual([]);
  });
});

describe('ActivePins layer (source pins)', () => {
  const src = () => fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'map', 'ActivePins.js'), 'utf8');

  it('pins active entries asynchronously in batches', () => {
    const s = src();
    expect(s, 'selection must come from the pure helper')
      .toMatch(/pinEntries\(/);
    expect(s, 'batches must come from the pure helper').toMatch(/batches\(/);
    expect(s, 'batch chaining must be async (timer/rAF, not a sync loop)')
      .toMatch(/setTimeout|requestAnimationFrame/);
    expect(s, 'pending batches must be cancelled on unmount')
      .toMatch(/clearTimeout|cancelAnimationFrame/);
    expect(s, 'pins are clickable -> viewSim').toMatch(/onViewSim\(/);
    expect(s, 'the currently active sim pin is marked')
      .toMatch(/activeSimId/);
    /* stacking: the network-roads canvas is appended to the MAP CONTAINER
     * (overlay.js: getContainer().appendChild) at z 640 — and .leaflet-
     * map-pane is a transformed stacking context pinned at 0 in that
     * container, so NO Leaflet pane can render above the roads. The pins
     * must be a plain DOM layer in the container itself, z 645 (above the
     * canvas, below the controls). */
    expect(s, 'pins render in a container-level DOM layer, not a Leaflet pane')
      .toMatch(/active-pins-layer/);
    expect(s, 'layer must live in the map container')
      .toMatch(/getContainer\(\)\.appendChild/);
    expect(s, 'layer z-index sits above .sim-canvas (640)').toMatch(
      /LAYER_Z\s*=\s*64[5-9]|zIndex\s*=\s*['"]?64[5-9]/);
    expect(s, 'no Leaflet pane/tooltip usage (they stack under the canvas)')
      .not.toMatch(/createPane|bindTooltip/);
    expect(s, 'pins must track pan/zoom (container points recomputed)')
      .toMatch(/latLngToContainerPoint/);
  });

  it('main.js styles the container-level pin layer', () => {
    const s = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'main.js'), 'utf8');
    expect(s, '.active-pins-layer CSS must be present')
      .toMatch(/\.active-pins-layer\{/);
    expect(s, 'pins must not block map interaction except the pin itself')
      .toMatch(/pointer-events/);
  });
});
