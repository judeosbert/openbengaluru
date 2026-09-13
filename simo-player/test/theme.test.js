/* Warm "Paper" theme adoption (design/design-sheet.html decision) — the
 * app's live theme is the generated BALAGERE_CSS_STYLE :root (dark), which
 * is NEVER hand-edited (public/data.js is emitted by sim/build_player.py).
 * The theme therefore applies as a token override block appended to
 * EXTRA_CSS in src/main.js: every color stays a CSS custom property, so a
 * future theme switch = swapping that one :root block.
 *
 * Source-pinned like test/html.test.js — the vitest env is node (no DOM);
 * EXTRA_CSS is extracted from src/main.js by evaluating its pure string
 * concatenation, and the generated blob is parsed via readDataConsts. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT, readDataConsts } from './helpers/dataConsts.js';

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

const MAIN = read('src', 'main.js');
const BALAGERE = readDataConsts().BALAGERE_CSS_STYLE;

/* EXTRA_CSS is a single-quoted JS string-concat expression in main.js —
 * evaluate it as-is (no DOM, no imports: it is a literal concatenation). */
const EXTRA = (() => {
  const start = MAIN.indexOf("const EXTRA_CSS = ''");
  expect(start, 'main.js must define EXTRA_CSS as a string concat')
    .toBeGreaterThanOrEqual(0);
  const end = MAIN.indexOf('const __simoStyle', start);
  expect(end, 'EXTRA_CSS expression must be terminated before use').toBeGreaterThan(0);
  const expr = MAIN.slice(MAIN.indexOf('=', start) + 1, MAIN.lastIndexOf(';', end));
  return new Function('return (' + expr + ');')();
})();

const COMBINED = BALAGERE + EXTRA;
const INDEX = read('index.html');
const EXPORT = read('src', 'components', 'ExportFlow.js');
const OVERLAY = read('src', 'map', 'overlay.js');

/* lastRule(css, selRegexSrc) — body of the LAST declaration block whose
 * selector ends with the given selector fragment: the cascade winner at
 * equal specificity, which is exactly how the override works. The fragment
 * is a regex source; caller escapes dots. */
function lastRule(css, selSrc) {
  const re = new RegExp('(?:^|[\\n}])[^{}]*?' + selSrc + '\\s*\\{([^}]*)\\}', 'g');
  let m, last = null;
  while ((m = re.exec(css)) !== null) last = m[1];
  return last;
}

function expectRule(css, selSrc, label) {
  const r = lastRule(css, selSrc);
  expect(r, `${label}: no rule for ${selSrc} found`).not.toBeNull();
  return r;
}

describe('Paper theme tokens (colors stay variables)', () => {
  it('generated BALAGERE_CSS_STYLE is untouched — dark :root still present', () => {
    /* public/data.js is generator-owned (sim/build_player.py); the theme
     * must NOT be applied by editing it — the dark tokens prove the blob
     * is byte-original and the override happens later in the cascade. */
    expect(BALAGERE).toContain('--ground:#0B0B0C');
    expect(BALAGERE).toContain('--accent:#E50914');
  });

  it('EXTRA_CSS carries a Paper :root override block — full palette', () => {
    /* the one place a future theme swap touches */
    const tokens = {
      '--ground': '#F7F1E7', '--surface': '#FFFDF8', '--surface2': '#F2E9DB',
      '--hair': 'rgba\\(74,55,40,\\.14\\)',
      '--ink': '#2E241C', '--ink2': '#5C4C3E', '--ink3': '#8A7A66',
      '--accent': '#C2502E', '--accent-ink': '#A03F22',
      '--green': '#3E7C4F', '--amber': '#B8771F', '--red': '#BE4436',
      '--today': '#4E6E8E',
      '--on-accent': '#FFFDF8',
    };
    for (const [k, val] of Object.entries(tokens)) {
      expect(EXTRA, `token ${k}:${val} must be overridden in EXTRA_CSS :root`)
        .toMatch(new RegExp(k + '\\s*:\\s*' + val));
    }
    /* structural tokens a theme swap carries along */
    for (const k of ['--veil:', '--tag-bg:', '--tag-ink:', '--shadow-lg:',
      '--shadow-sm:', '--serif:', '--r-xs:', '--r-sm:', '--r-md:', '--r-lg:',
      '--road-core:', '--road-casing:', '--draft-casing:', '--accent-dim:',
      '--green-dim:', '--accent-soft:']) {
      expect(EXTRA, `token ${k} must exist in EXTRA_CSS :root`).toContain(k);
    }
  });

  it('no hardcoded dark-theme / Netflix-red colors remain in EXTRA_CSS', () => {
    /* the Google CTA (.gbtn) is a brand element and keeps its white field —
     * signin-gate.test.js pins it; nothing else may hardcode the old
     * console surfaces. Black shadows become var(--shadow-*) tokens. */
    expect(EXTRA)
      .not.toMatch(/#E50914|rgba\(23,23,26|rgba\(11,11,12|rgba\(10,10,12|rgba\(0,0,0/);
  });

  it('veils, pin tags, zone badges and attribution re-declare the tag tokens', () => {
    expect(expectRule(COMBINED, '\\.modal-veil', '.modal-veil'))
      .toMatch(/var\(--veil\)/);
    expect(expectRule(COMBINED, '\\.dash-veil', '.dash-veil'))
      .toMatch(/var\(--veil\)/);
    expect(expectRule(COMBINED, '\\.sim-pin \\.tag', '.sim-pin .tag'))
      .toMatch(/var\(--tag-bg\)/);
    expect(expectRule(COMBINED, '\\.zone-badge span', '.zone-badge span'))
      .toMatch(/var\(--tag-bg\)/);
    expect(expectRule(COMBINED, '\\.leaflet-control-attribution', 'attribution'))
      .toMatch(/var\(--tag-bg\)/);
    expect(expectRule(EXTRA, '\\.active-pins-layer \\.sim-pin \\.tip', '.tip'))
      .toMatch(/var\(--tag-bg\)/);
    expect(expectRule(EXTRA, '\\.viewtoggle button\\.on', 'view toggle on'))
      .toMatch(/var\(--on-accent\)/);
  });

  it('warm shadows replace the black console shadows', () => {
    for (const sel of ['\\.sheet', '\\.modal', '\\.toast', '\\.anchor-bar', '\\.dash']) {
      const r = expectRule(EXTRA, sel, sel);
      expect(r, `${sel} shadow must come from a token`)
        .toMatch(/var\(--shadow-(lg|sm)\)/);
      expect(r, `${sel} shadow must not hardcode black`).not.toMatch(/rgba\(0,0,0/);
    }
    expect(expectRule(EXTRA, '\\.leaflet-control-zoom', 'zoom control'))
      .toMatch(/var\(--shadow-sm\)/);
  });

  it('map tiles render light warm — the dark invert filter is overridden', () => {
    const r = expectRule(COMBINED, '\\.leaflet-tile-pane', 'tile filter');
    expect(r).not.toMatch(/invert\(1\)/);
    expect(r).toMatch(/sepia\(/);
  });

  it('generous radii via tokens on the key surfaces', () => {
    for (const sel of ['\\.row-item', '\\.comment', '\\.chip']) {
      expect(expectRule(EXTRA, sel, sel), `${sel} radius must use a token`)
        .toMatch(/var\(--r-(xs|sm|md|lg)\)/);
    }
    expect(expectRule(EXTRA, '(?:^|\\n)button(?![\\w.-])', 'bare button'))
      .toMatch(/var\(--r-sm\)/);
  });

  it('display serif for emotional moments, with offline fallbacks', () => {
    expect(EXTRA).toMatch(/--serif:"Fraunces"[^;]*Georgia/);
    expect(EXTRA).toMatch(/--body:"Inter"[^;]*-apple-system/);
    for (const sel of ['\\.sheet h2', '\\.modal h3', '\\.mark(?![\\w-])']) {
      expect(expectRule(EXTRA, sel, sel), `${sel} must use the display serif`)
        .toMatch(/var\(--serif\)/);
    }
    expect(expectRule(EXTRA, '\\.mark small', '.mark small'))
      .toMatch(/var\(--mono\)/);
  });

  it('Google Fonts wired in index.html (swap, with system fallbacks in CSS)', () => {
    expect(INDEX).toMatch(/fonts\.googleapis\.com\/css2\?family=Fraunces/);
    expect(INDEX).toMatch(/family=Inter/);
    expect(INDEX).toMatch(/display=swap/);
  });

  it('sim canvas colors read the tokens, no dark literals remain', () => {
    /* canvas paints cannot use var() — overlay.js reads the custom
     * properties once (lazy) and paints with the resolved values. */
    for (const name of ['--road-core', '--road-casing', '--draft-casing',
      '--accent-ink', '--accent-dim', '--green-dim', '--today', '--ground']) {
      expect(OVERLAY, `overlay must read token ${name}`).toContain("'" + name + "'");
    }
    expect(OVERLAY).not.toMatch(
      /#E50914|229,9,20|#FF5A60|rgba\(11,11,12|#3A3A40|#222227|#46464C|#9670C8/
    );
    expect(OVERLAY).not.toMatch(
      /#35C46B|#288C50|#F0A02B|\[53,196,107\]|\[240,160,43\]|\[245,72,79\]/
    );
    /* speed gradient keeps its shape, colors from tokens */
    expect(OVERLAY).toMatch(/export function speedColor/);
  });

  it('export bbox + crosshair colors come from tokens', () => {
    expect(EXPORT, 'bbox rect must be token-styled via className')
      .toMatch(/className: 'export-bbox'/);
    expect(EXPORT).not.toMatch(/#E50914|rgba\(229,9,20/);
    expect(expectRule(EXTRA, '\\.export-bbox', '.export-bbox'))
      .toMatch(/stroke:var\(--accent\)/);
    expect(expectRule(EXTRA, '\\.export-crosshair i', 'crosshair'))
      .toMatch(/background:var\(--accent\)/);
  });
});