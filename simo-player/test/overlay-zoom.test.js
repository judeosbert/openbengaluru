/* Smooth zoom for the sim canvas overlay — plan
 * .kilo/plans/1789317321184-smooth-zoom-overlay.md.
 *
 * Two layers, repo-idiomatic (vitest is node-env, no DOM):
 * 1. zoomCanvasTransform (src/map/zoomTransform.js, plain numbers): the
 *    translate3d/scale that maps the last painted frame onto Leaflet's
 *    animated-zoom target so the canvas rides the tiles during the 250ms
 *    transition instead of freezing and snapping on zoomend.
 * 2. Source pins on src/map/overlay.js wiring (html.test.js /
 *    active-pins.test.js precedent): zoomanim register/unregister, the
 *    raster-scale call, the crisp repaint reset, transform-origin.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { zoomCanvasTransform } from '../src/map/zoomTransform.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

describe('zoomCanvasTransform (pure math)', () => {
  it('zoom in 12 -> 13: scale exactly 2, hand-computed offsets', () => {
    /* painted view: zoom 12, origin (1e6, 7e5). Target: zoom 13 centered at
     * zoom-13 px (2_002_000, 1_401_000).
     * targetOrigin = (2_002_000-400, 1_401_000-300) = (2_001_600, 1_400_700)
     * offset = paintedOrigin*scale - targetOrigin = (-1_600, -700). */
    const t = zoomCanvasTransform(800, 600, 12,
      1_000_000, 700_000, 2_002_000, 1_401_000, 13);
    expect(t.scale).toBe(2);
    expect(t.offsetX).toBe(-1_600);
    expect(t.offsetY).toBe(-700);
  });

  it('zoom out 13 -> 12 (reverse of the zoom-in view): scale 0.5', () => {
    /* The zoom-in case settled at zoom 13 (origin 2_001_600, 1_400_700);
     * zoom back out to the same geographic center, whose zoom-12 px are
     * (1_001_000, 700_500). targetOrigin = (1_000_600, 700_200);
     * offset = (2_001_600*0.5 - 1_000_600, 1_400_700*0.5 - 700_200)
     *        = (200, 150) — the painted top-left re-enters at (200, 150). */
    const t = zoomCanvasTransform(800, 600, 13,
      2_001_600, 1_400_700, 1_001_000, 700_500, 12);
    expect(t.scale).toBe(0.5);
    expect(t.offsetX).toBe(200);
    expect(t.offsetY).toBe(150);
  });

  it('fractional pinch-settle 12 -> 12.5: scale sqrt(2)', () => {
    /* same geographic center -> targetOrigin == paintedOrigin, so
     * offset = paintedOrigin * (2^0.5 - 1), per axis. */
    const t = zoomCanvasTransform(800, 600, 12,
      1_000_000, 700_000, 1_000_400, 700_300, 12.5);
    expect(t.scale).toBeCloseTo(Math.SQRT2, 12);
    expect(t.offsetX).toBeCloseTo(1_000_000 * Math.SQRT2 - 1_000_000, 6);
    expect(t.offsetY).toBeCloseTo(700_000 * Math.SQRT2 - 700_000, 6);
  });

  it('identity: same zoom, center at paintedOrigin + size/2 -> no transform', () => {
    const t = zoomCanvasTransform(800, 600, 12,
      1_000_000, 700_000, 1_000_400, 700_300, 12);
    expect(t.scale).toBe(1);
    expect(t.offsetX).toBe(0);
    expect(t.offsetY).toBe(0);
  });
});

describe('overlay.js zoomanim wiring (source pins)', () => {
  const src = () => fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'map', 'overlay.js'), 'utf8');

  it('registers zoomanim in onAdd and unregisters in onRemove', () => {
    const s = src();
    expect(s, 'onAdd must register the zoomanim handler')
      .toMatch(/\.on\(\s*'zoomanim'\s*,\s*onZoomAnim/);
    expect(s, 'onRemove must unregister the zoomanim handler')
      .toMatch(/\.off\(\s*'zoomanim'\s*,\s*onZoomAnim/);
  });

  it('zoomanim handler raster-scales the canvas to the animation target', () => {
    const s = src();
    expect(s, 'target transform must come from the pure helper')
      .toMatch(/zoomCanvasTransform\(/);
    expect(s, 'canvas must get translate3d/scale via L.DomUtil.setTransform')
      .toMatch(/L\.DomUtil\.setTransform\(\s*canvas\b/);
    expect(s, 'transition must mirror leaflet.css .leaflet-zoom-anim')
      .toMatch(/transform 0\.25s cubic-bezier\(0,0,0\.25,1\)/);
  });

  it('draw resets the zoom transform and repaints crisp', () => {
    const s = src();
    expect(s, 'draw must clear the applied canvas transform')
      .toMatch(/canvas\.style\.transform\s*=\s*''/);
    expect(s, 'draw must clear the 250ms transition')
      .toMatch(/canvas\.style\.transition\s*=\s*''/);
  });

  it('canvas is transform-animatable (transform-origin 0 0)', () => {
    expect(src(), 'equivalent of the leaflet-zoom-animated class')
      .toMatch(/transformOrigin\s*=\s*'0 0'/);
  });
});