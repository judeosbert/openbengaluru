/* Active-pin contract: review-flow ACTIVE entries (apiStream-stamped by
 * the boot merge of GET /api/catalog) get map pins; the preloaded
 * base-bundle entries stay marker-free. Pins are added ASYNCHRONOUSLY in
 * BATCHES on page load. The pure selection/chunking helpers live in
 * src/lib/pins.js (DOM-free, node-testable); the Leaflet layer
 * (src/map/ActivePins.js) is source-pinned (html.test.js precedent). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pinEntries, batches, pinNeighbors, spreadOverlaps }
  from '../src/lib/pins.js';
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

describe('pinNeighbors (pure overlap query)', () => {
  /* container points (px): b ~8.9px from a, d ~1.4px, c 50px */
  const pts = () => new Map([
    ['a', [100, 100]],
    ['b', [108, 104]],
    ['c', [150, 100]],
    ['d', [99, 101]],
    ['bad', [12.9]],
    ['nan', [NaN, 5]],
  ]);

  it('lists ids within the radius, nearest first, excluding the queried id',
    () => {
      expect(pinNeighbors('a', pts(), 10)).toEqual(['d', 'b']);
    });

  it('boundary is inclusive (d === radius counts as overlapping)', () => {
    const two = new Map([['a', [0, 0]], ['b', [10, 0]]]);
    expect(pinNeighbors('a', two, 10)).toEqual(['b']);
  });

  it('returns [] for isolated pins, unknown ids, and non-positive radius',
    () => {
      expect(pinNeighbors('c', pts(), 10)).toEqual([]);
      expect(pinNeighbors('zz', pts(), 10)).toEqual([]);
      expect(pinNeighbors('a', pts(), 0)).toEqual([]);
      expect(pinNeighbors('a', pts(), -3)).toEqual([]);
    });

  it('skips malformed points without throwing', () => {
    const near = pinNeighbors('a', pts(), 10);
    expect(near).not.toContain('bad');
    expect(near).not.toContain('nan');
  });

  it('tolerates an empty/missing point map', () => {
    expect(pinNeighbors('a', new Map(), 10)).toEqual([]);
    expect(pinNeighbors('a', null, 10)).toEqual([]);
  });
});

describe('spreadOverlaps (pure vertical spread layout)', () => {
  /* display positions for the ActivePins layer: pins whose points sit
   * within radiusPx are re-laid as a vertical column (spacingPx apart,
   * centred on the cluster's mean point) so every marker stays visible
   * and individually clickable; isolated pins keep their exact point.
   * Cluster members are ordered by (y, x, then insertion order). */

  it('keeps isolated pins at their exact container points', () => {
    const pts = new Map([['a', [100, 100]], ['far', [500, 500]]]);
    const out = spreadOverlaps(pts, 16, 20);
    expect(out.get('a')).toEqual([100, 100]);
    expect(out.get('far')).toEqual([500, 500]);
  });

  it('returns to exact anchors once zoom separates the pins', () => {
    const pts = new Map([['a', [0, 0]], ['b', [60, 0]]]);
    const out = spreadOverlaps(pts, 16, 20);
    expect(out.get('a')).toEqual([0, 0]);
    expect(out.get('b')).toEqual([60, 0]);
  });

  it('spreads two overlapping pins into a vertical column', () => {
    const pts = new Map([['a', [100, 100]], ['b', [108, 104]]]); // ~8.9px
    const out = spreadOverlaps(pts, 16, 20);
    const [ax, ay] = out.get('a');
    const [bx, by] = out.get('b');
    expect(by - ay).toBe(20);                // spacingPx apart, a above b
    expect(ax).toBe(bx);                     // one aligned column
    expect((ay + by) / 2).toBeCloseTo(102);  // centred on the mean y
    expect(ax).toBeCloseTo(104);             // at the mean x
  });

  it('orders coincident pins deterministically (y, x, then insertion)', () => {
    const pts = new Map([['first', [100, 100]], ['second', [100, 100]]]);
    const out = spreadOverlaps(pts, 16, 20);
    expect(out.get('first')).toEqual([100, 90]);   // upper slot
    expect(out.get('second')).toEqual([100, 110]); // lower slot
  });

  it('merges chains transitively (a-b, b-c within radius -> one column)',
    () => {
      /* a-c is 28px (> 16) but the a-b-c chain is one cluster */
      const pts = new Map([['a', [0, 0]], ['b', [0, 14]], ['c', [0, 28]]]);
      const out = spreadOverlaps(pts, 16, 20);
      expect(out.get('a')).toEqual([0, -6]);
      expect(out.get('b')).toEqual([0, 14]);
      expect(out.get('c')).toEqual([0, 34]);
    });

  it('fixpoints: no two spread positions remain within the radius', () => {
    /* two clumps whose single-pass columns would still collide */
    const pts = new Map([
      ['a1', [0, 0]], ['a2', [0, 10]],
      ['b1', [30, 12]], ['b2', [30, 22]],
    ]);
    const out = spreadOverlaps(pts, 16, 20);
    const ids = [...out.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let k = i + 1; k < ids.length; k++) {
        const [x1, y1] = out.get(ids[i]);
        const [x2, y2] = out.get(ids[k]);
        expect(Math.hypot(x2 - x1, y2 - y1), `${ids[i]} vs ${ids[k]}`)
          .toBeGreaterThan(16);
      }
    }
  });

  it('skips malformed points (they pass through at their coords)', () => {
    const pts = new Map([
      ['a', [100, 100]], ['bad', [12.9]], ['nan', [NaN, 5]],
    ]);
    const out = spreadOverlaps(pts, 16, 20);
    expect(out.get('bad')).toEqual([12.9]);
    expect(out.get('nan')).toEqual([NaN, 5]);
    expect(out.get('a')).toEqual([100, 100]); // no valid neighbours
  });

  it('tolerates empty/missing maps and non-positive radius/spacing', () => {
    expect(spreadOverlaps(new Map(), 16, 20)).toEqual(new Map());
    expect(spreadOverlaps(null, 16, 20)).toEqual(new Map());
    const two = new Map([['a', [0, 0]], ['b', [10, 0]]]);
    expect(spreadOverlaps(two, 0, 20).get('b')).toEqual([10, 0]);
    expect(spreadOverlaps(two, 16, 0).get('b')).toEqual([10, 0]);
    expect(spreadOverlaps(two, -3, 20).get('b')).toEqual([10, 0]);
  });

  it('returns a new map — the input is never mutated', () => {
    const pts = new Map([['a', [100, 100]], ['b', [108, 104]]]);
    const out = spreadOverlaps(pts, 16, 20);
    expect(out).not.toBe(pts);
    expect(pts.get('a')).toEqual([100, 100]);
    expect(pts.get('b')).toEqual([108, 104]);
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

  it('overlapping pins spread into a vertical list; clicks play directly',
    () => {
      const s = src();
      expect(s, 'the spread layout must come from the pure helper')
        .toMatch(/spreadOverlaps\(/);
      const sync = /const sync = \(\) => \{([\s\S]*?)\n    \};/.exec(s);
      expect(sync, 'sync block must exist').toBeTruthy();
      expect(sync[1], 'pan/zoom must recompute the spread layout')
        .toMatch(/layout\(\)/);
      expect(s, 'every pin click plays its sim directly (spread pins are '
        + 'individually clickable — no chooser popup)')
        .toMatch(/onViewSim\(e\.id\)/);
      /* the chooser popup is retired by the vertical spread — none of its
       * machinery may remain */
      expect(s, 'no chooser popup element or has-list class may remain')
        .not.toMatch(/pin-picker|has-list/);
      expect(s, 'no popup dismissal machinery may remain')
        .not.toMatch(/map\.on\('click'|keydown|Escape/);
      expect(s, 'no hover wiring may remain').not.toMatch(/mouseenter/);
      expect(s, 'the delayed-hide grace machinery must be gone')
        .not.toMatch(/HIDE_MS|hideTimer/);
    });

  it('reads Leaflet Points via .x/.y — Points have no .toArray()', () => {
    const s = src();
    /* map.latLngToContainerPoint() returns a Leaflet Point ({x, y}) — it
     * has no .toArray() method, and calling it throws 'toArray is not a
     * function' the moment a pin is clicked in a real browser (uncovered
     * by the node env, so source-pinned). Container points are read as
     * plain [x, y] pairs instead. */
    expect(s, 'container points must come from Point .x/.y — a Leaflet '
      + 'Point has no .toArray() (crashes on click in-browser)')
      .not.toMatch(/\.toArray\(\)/);
  });

  it('main.js styles the container-level pin layer', () => {
    const s = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'main.js'), 'utf8');
    expect(s, '.active-pins-layer CSS must be present')
      .toMatch(/\.active-pins-layer\{/);
    expect(s, 'pins must not block map interaction except the pin itself')
      .toMatch(/pointer-events/);
    expect(s, 'the chooser popup CSS is retired — overlapping pins '
      + 'spread in place instead')
      .not.toMatch(/pin-picker|has-list/);
  });
});
