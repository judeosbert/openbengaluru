/* Intro backdrop 16:9 cover-fit (mobile fix): the canvas scene was designed
 * on a 16:9 desktop box; mapping its fractional INTRO_ROADS coordinates with
 * independent axes squishes the rings on portrait phones. The fix covers
 * the viewport with a uniformly scaled 16:9 design box (crop overflow) —
 * at exactly 16:9 the math reduces to today's full-viewport mapping, so
 * desktop rendering is unchanged.
 *
 * The mapping lives in src/lib/introScene.js — pure math (lib-purity owns
 * the DOM-free guarantee); the component tests pin that IntroShell routes
 * its draw through it (source-regex style, node env). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';
import {
  SCENE_REF_W, SCENE_REF_H,
  sceneScale, sceneX, sceneY, sceneLenX, sceneLenY,
} from '../src/lib/introScene.js';

const read = (...parts) => fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');

describe('introScene mapping (src/lib/introScene.js)', () => {
  it('reference box is 16:9', () => {
    expect(SCENE_REF_W / SCENE_REF_H).toBe(16 / 9);
  });

  it('at 16:9 the mapping reduces to the full-viewport fraction math', () => {
    /* desktop rendering unchanged: fractions land on the same pixels */
    const s = sceneScale(1920, 1080);
    expect(s).toBe(1.2);
    expect(SCENE_REF_W * s).toBe(1920);
    expect(SCENE_REF_H * s).toBe(1080);
    expect(sceneLenX(0.36, s)).toBe(0.36 * 1920);
    expect(sceneLenY(0.38, s)).toBe(0.38 * 1080);
    /* positions: verified float noise differs only in the last ulp */
    expect(sceneX(0.36, 1920, s)).toBeCloseTo(0.36 * 1920, 12);
    expect(sceneY(0.38, 1080, s)).toBeCloseTo(0.38 * 1080, 12);
    expect(sceneX(0.5, 1920, s)).toBeCloseTo(960, 12);
    expect(sceneY(0.5, 1080, s)).toBeCloseTo(540, 12);
  });

  it('portrait: the ring keeps its shape and is cut at the sides, not squished', () => {
    const s = sceneScale(390, 844);
    const rx = sceneLenX(0.36, s);
    const ry = sceneLenY(0.38, s);
    /* 0.36 * 1600 * (844/900) ≈ 540 — far wider than the 390px viewport */
    expect(rx).toBeCloseTo(540, 0);
    /* vertically the ring still fits: 0.38 * 844 < 844/2 */
    expect(ry).toBeLessThan(844 / 2);
    const cx = sceneX(0.5, 390, s);
    expect(cx - rx).toBeLessThan(0);
    expect(cx + rx).toBeGreaterThan(390);
  });

  it('aspect is preserved across orientations', () => {
    const portrait = sceneLenX(0.36, sceneScale(390, 844))
      / sceneLenY(0.38, sceneScale(390, 844));
    const desktop = sceneLenX(0.36, sceneScale(1920, 1080))
      / sceneLenY(0.38, sceneScale(1920, 1080));
    expect(portrait).toBeCloseTo(desktop, 12);
  });

  it('cover: the scale never undershoots either axis', () => {
    for (const [w, hgt] of [[390, 844], [1920, 1080], [844, 390], [1024, 768]]) {
      const s = sceneScale(w, hgt);
      expect(s).toBeGreaterThanOrEqual(w / SCENE_REF_W);
      expect(s).toBeGreaterThanOrEqual(hgt / SCENE_REF_H);
    }
  });
});

describe('IntroShell routes the canvas draw through the mapping', () => {
  const introSrc = () => read('src', 'components', 'IntroShell.js');

  it('imports the pure scene mapping from src/lib', () => {
    expect(introSrc())
      .toMatch(/import \{[^}]*sceneScale[^}]*\} from '\.\.\/lib\/introScene\.js'/);
  });

  it('draw computes the scene scale and maps every shape through it', () => {
    const s = introSrc();
    expect(s).toMatch(/const s = sceneScale\(w, hgt\)/);
    /* ring */
    expect(s).toMatch(/sceneLenX\(it\.rx, s\)/);
    expect(s).toMatch(/sceneLenY\(it\.ry, s\)/);
    /* lines */
    expect(s).toMatch(/ctx\.moveTo\(sceneX\(it\.x1, w, s\), sceneY\(it\.y1, hgt, s\)\)/);
    /* grid: origin + cell size route through the mapping */
    expect(s).toMatch(/sceneLenX\(it\.size, s\) \/ it\.cols/);
    expect(s).toMatch(/sceneLenY\(it\.size, s\) \/ it\.rows/);
    /* lake: radius via sceneLenX stays circular */
    expect(s).toMatch(/ctx\.arc\(sceneX\(it\.cx, w, s\), sceneY\(it\.cy, hgt, s\), sceneLenX\(it\.r, s\)/);
  });

  it('INTRO_ROADS fractions, drafting dots and parallax stay unchanged', () => {
    const s = introSrc();
    expect(s).toMatch(/\{ type: 'ring', cx: \.50, cy: \.50, rx: \.36, ry: \.38 \}/);
    expect(s).toMatch(/for \(let x = 0; x < w; x \+= 40\)/);
    expect(s).toMatch(/const ox = \(mx - w \/ 2\) \* 0\.015/);
  });
});
