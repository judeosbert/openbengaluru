/* SimPanel bottom sheet on phones (<=900px): the generated .sheet is a
 * 360px right side panel inside .map-wrap — on a phone it swallows the
 * screen. The fix (user-approved): media-query it into a bottom sheet
 * capped at 62%, collapse it to the 56px title strip when the sim runs,
 * and drag the grip/title (or tap the strip) to re-expand.
 *
 * Strip vs body: the grip/h2/✕ strip sits OUTSIDE the scroll — only
 * .sheet-body scrolls (overflow-y on .sheet itself would scroll the strip
 * away). Minimized, the sheet gets touch-action:none: nothing scrolls and
 * a swipe anywhere on the strip expands. Mobile content order puts the
 * Run button on top, then the sliders, then the numbers, then FILES.
 *
 * Focus: <=900px the open sheet covers up to 62% of the map, so the snap
 * effects fit the sim into the visible band above it (paddingBottomRight).
 *
 * Source-regex style like test/simpanel-files.test.js — the vitest env is
 * node, so UI contracts lock on source text. EXTRA_CSS is stitched with
 * the same `'\s*\+\s*'` idiom. Theme-contract note: the media rules that
 * restyle the pinned base selectors use the :where(*) tail on purpose
 * (test/theme.test.js reads the LAST rule per selector tail — a rule
 * ending in bare `.sheet` would steal its `box-shadow:var(--shadow-lg)`
 * pin); the tail also keeps the (0,1,0)/(0,2,0) cascade intact. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const panel = () => fs.readFileSync(
  path.join(PLAYER_ROOT, 'src', 'components', 'SimPanel.js'), 'utf8');

const read = (...parts) => fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');

const extraCss = () => read('src', 'main.js')
  /* stitch the EXTRA_CSS string-concatenation back into one stylesheet */
  .replace(/'\s*\+\s*'/g, '');

/* the mobile-sheet media block is the last @media (max-width:900px) BEFORE
 * the capture page section — the capture mobile block lands after it and
 * owns its own <=900px rules (pinned by test/capture.test.js) */
const sheetMedia = () => {
  const css = extraCss();
  const cap = css.indexOf('/* capture page */');
  const i = css.lastIndexOf('@media (max-width:900px)', cap);
  expect(i, 'mobile media block missing').toBeGreaterThanOrEqual(0);
  return css.slice(i);
};

describe('EXTRA_CSS: the sheet becomes a bottom sheet <=900px', () => {
  it('the sheet anchors to the bottom, capped at 62% — and never scrolls itself', () => {
    const m = sheetMedia();
    const rule = m.match(/\.sheet:where\(\*\)\{([^}]*)\}/);
    expect(rule, '.sheet:where(*) rule missing from the media block').not.toBeNull();
    const body = rule[1];
    expect(body).toMatch(/top:auto/);
    expect(body).toMatch(/left:0/);
    expect(body).toMatch(/right:0/);
    expect(body).toMatch(/bottom:0/);
    expect(body).toMatch(/width:auto/);
    expect(body).toMatch(/height:auto/);
    expect(body).toMatch(/max-height:62%/);
    expect(body).toMatch(/border-left:0/);
    expect(body).toMatch(/border-top:1px solid var\(--hair\)/);
    expect(body).toMatch(/border-radius:var\(--r-lg\) var\(--r-lg\) 0 0/);
    expect(body).toMatch(/transition:[^;}]*transform[^;}]*cubic-bezier/);
    /* the strip must stay put: scrolling belongs to .sheet-body below */
    expect(body).not.toMatch(/overflow/);
  });

  it('only .sheet-body scrolls; the base rule keeps the desktop flex layout', () => {
    /* desktop: the wrapper is a flex column filling the sheet under the
     * h2, so .actions{margin-top:auto} still pushes Run to the bottom */
    expect(extraCss()).toMatch(
      /\.sheet-body\{display:flex;flex-direction:column;flex:1;min-height:0\}/);
    const m = sheetMedia();
    const rule = m.match(/\.sheet \.sheet-body:where\(\*\)\{([^}]*)\}/);
    expect(rule, 'media .sheet .sheet-body:where(*) rule missing').not.toBeNull();
    expect(rule[1]).toMatch(/overflow-y:auto/);
    expect(rule[1]).toMatch(/overscroll-behavior:contain/);
  });

  it('touch-action stays off .sheet itself — the body must keep scrolling', () => {
    /* pointer handlers live on the sheet root; touch-action:none there
     * would kill body touch scrolling (touch-action intersects down the
     * ancestor chain) */
    const m = sheetMedia();
    const rule = m.match(/\.sheet:where\(\*\)\{([^}]*)\}/);
    expect(rule[1]).not.toMatch(/touch-action/);
  });

  it('collapsed keeps only the 56px strip, cannot scroll, swipe expands', () => {
    const m = sheetMedia();
    const rule = m.match(/\.sheet\.sheet-collapsed:where\(\*\)\{([^}]*)\}/);
    expect(rule, '.sheet.sheet-collapsed rule missing').not.toBeNull();
    expect(rule[1]).toMatch(/transform:translateY\(calc\(100% - 56px\)\)/);
    /* minimized: no scroll gesture anywhere — the pointer handlers own it */
    expect(rule[1]).toMatch(/touch-action:none/);
    expect(m).toMatch(
      /\.sheet\.sheet-drag:where\(\*\)\{[^}]*transition:none/);
    expect(m).toMatch(/\.sheet\.sheet-drag:where\(\*\)\{[^}]*user-select:none/);
  });

  it('grip: hidden on desktop, shown only inside the media block', () => {
    const css = extraCss();
    const base = css.indexOf('.sheet-grip{display:none}');
    expect(base, 'base .sheet-grip{display:none} rule missing')
      .toBeGreaterThanOrEqual(0);
    expect(base).toBeLessThan(css.lastIndexOf('@media (max-width:900px)'));
    const m = sheetMedia();
    const rule = m.match(/\.sheet \.sheet-grip:where\(\*\)\{([^}]*)\}/);
    expect(rule, 'media .sheet .sheet-grip:where(*) rule missing').not.toBeNull();
    expect(rule[1]).toMatch(/display:block/);
    expect(rule[1]).toMatch(/touch-action:none/);
  });

  it('the title strip drags without scrolling; .map-wrap clips the sheet', () => {
    const m = sheetMedia();
    expect(m).toMatch(/\.sheet h2:where\(\*\)\{[^}]*touch-action:none/);
    expect(m).toMatch(/\.map-wrap\{overflow:hidden\}/);
  });

  it('mobile order: Run on top, then sliders, then numbers, then FILES', () => {
    const m = sheetMedia();
    expect(m).toMatch(/\.sheet \.actions:where\(\*\)\{[^}]*order:-6/);
    expect(m).toMatch(/\.sheet \.fld:where\(\*\)\{[^}]*order:-5/);
    expect(m).toMatch(/\.sheet \.statgrid:where\(\*\)\{[^}]*order:-4/);
    expect(m).toMatch(/\.sheet \.scen-toggle:where\(\*\)\{[^}]*order:-3/);
    /* FILES last — the more specific tail overrides the sliders' order */
    expect(m).toMatch(/\.sheet \.fld\.files:where\(\*\)\{[^}]*order:1/);
  });
});

describe('SimPanel: collapse / drag / tap behavior', () => {
  it('the collapsed strip is 56px — JS constant mirrors the CSS', () => {
    expect(panel()).toMatch(/const STRIP_PX = 56/);
  });

  it('className wires the collapsed + dragging states onto the sheet root', () => {
    const s = panel();
    expect(s).toMatch(
      /className: 'sheet' \+ \(collapsed \? ' sheet-collapsed' : ''\) \+ \(dragging \? ' sheet-drag' : ''\)/);
    expect(s).toMatch(/ref: sheetRef/);
  });

  it('the title strip sits outside the scrollable body', () => {
    const s = panel();
    expect(s).toMatch(/h\('div', \{ className: 'sheet-body' \},/);
    /* grip, ✕ and h2 render before the body wrapper — always visible */
    const grip = s.indexOf("className: 'sheet-grip'");
    const closex = s.indexOf("className: 'ghost closex'");
    const h2 = s.indexOf("h('h2'");
    const body = s.indexOf("className: 'sheet-body'");
    expect(grip).toBeGreaterThan(-1);
    expect(closex).toBeGreaterThan(-1);
    expect(h2).toBeGreaterThan(-1);
    expect(grip).toBeLessThan(body);
    expect(closex).toBeLessThan(body);
    expect(h2).toBeLessThan(body);
  });

  it('Run on Map collapses the sheet and starts the sim', () => {
    expect(panel()).toMatch(/onClick: \(\) => \{ setCollapsed\(true\); onRun\(entry\.id\); \}/);
  });

  it('a newly selected sim always opens expanded', () => {
    expect(panel()).toMatch(/setCollapsed\(false\);\s*\}, \[entry\.id\]\)/);
  });

  it('the grip is the first child of the sheet, before the close button', () => {
    const s = panel();
    expect(s).toMatch(
      /h\('div', \{ className: 'sheet-grip' \}\),\s*h\('button', \{ className: 'ghost closex'/);
  });

  it('pointer drag starts only in the top strip and never on interactive targets', () => {
    const s = panel();
    expect(s).toMatch(/e\.clientY - rect\.top > STRIP_PX/);
    expect(s).toMatch(/closest\('button,a,input'\)/);
    expect(s).toMatch(/setPointerCapture\(/);
  });

  it('drag offset clamps between open and the 56px strip', () => {
    expect(panel()).toMatch(
      /Math\.max\(0, Math\.min\(d\.maxOff, d\.base \+ e\.clientY - d\.startY\)\)/);
    expect(panel()).toMatch(/base: collapsed \? rect\.height - STRIP_PX : 0/);
  });

  it('release: tap or fling up expands, fling down collapses, else snap back', () => {
    const s = panel();
    expect(s).toMatch(/Math\.abs\(dy\) < 6/);
    expect(s).toMatch(/dy < -40/);
    expect(s).toMatch(/dy > 40/);
    /* the inline transform is cleared so the CSS transition takes over */
    expect(s).toMatch(/sheet\.style\.transform = ''/);
  });
});

describe('mobile focus: the opened sheet never covers the sim', () => {
  const app = () => read('src', 'components', 'App.js');

  it('fit padding accounts for the bottom sheet <=900px', () => {
    const s = app();
    expect(s).toMatch(/function fitPadding\(m\)/);
    expect(s).toMatch(/matchMedia\('\(max-width:900px\)'\)/);
    expect(s).toMatch(
      /paddingBottomRight: \[24, Math\.round\(m\.getSize\(\)\.y \* 0\.62\)\]/);
    /* the auto-snap-on-open effect routes through the helper (the old
     * publish-snap effect is gone — local publishes no longer exist) */
    expect((s.match(/fitPadding\(map\)/g) || []).length).toBe(1);
  });

  it('desktop keeps the plain [48, 48] padding', () => {
    expect(app()).toMatch(/return \{ padding: \[48, 48\] \};/);
  });
});
