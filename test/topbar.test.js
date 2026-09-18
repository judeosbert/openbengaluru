/* Top bar redesign — Figma-style centered pill (max 3 visible views, always
 * including the active one) + a "More" dropdown, account-only avatar menu,
 * ghost actions + single accent CTA (plan:
 * .kilo/plans/1789320892907-topbar-redesign-plan.md).
 *
 * The vitest env is node (no DOM), so three pinning layers:
 * - the pure nav logic is EXPORTED from the component module and tested
 *   behaviorally (namespace import + calls — module scope touches no DOM,
 *   so importing TopBar.js in node is safe);
 * - the hook-bound render tree (menu open/close wiring) is pinned
 *   structurally against the source, same style as signin-gate.test.js;
 * - the CSS contract is pinned against EXTRA_CSS extracted exactly like
 *   test/theme.test.js, with lastRule cascade-winner checks over
 *   BALAGERE + EXTRA (the appended overrides must win at equal specificity).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT, readDataConsts } from './helpers/dataConsts.js';
import * as topbar from '../src/components/TopBar.js';

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

const TOPBAR = read('src', 'components', 'TopBar.js');
const MAIN = read('src', 'main.js');
const BALAGERE = readDataConsts().BALAGERE_CSS_STYLE;

/* same EXTRA_CSS extraction as test/theme.test.js — it is a pure string
 * concatenation, evaluated here without DOM or imports. */
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

/* lastRule(css, selRegexSrc) — body of the LAST declaration block whose
 * selector ends with the given fragment: the cascade winner at equal
 * specificity (ported from test/theme.test.js; it cannot see inside
 * @media blocks, which keeps static rules authoritative). */
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

const USER = { uid: 'u1', displayName: 'Jude', email: 'jude@example.org' };
const ids = (items) => items.map((i) => i.id);

describe('nav config (pure data, exported)', () => {
  it('NAV_ITEMS covers exactly the five views, in order, with labels', () => {
    const { NAV_ITEMS } = topbar;
    expect(Array.isArray(NAV_ITEMS), 'NAV_ITEMS must be an array').toBe(true);
    expect(ids(NAV_ITEMS)).toEqual(
      ['discover', 'contribute', 'dashboard', 'tutorials', 'admin']);
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(
      ['Discover', 'Contribute', 'Dashboard', 'Tutorials', 'Admin']);
    for (const item of NAV_ITEMS) {
      expect(typeof item.show, `${item.id}.show must be a predicate`)
        .toBe('function');
    }
    /* the vestigial 'submissions' view value must not re-enter the nav */
    expect(ids(NAV_ITEMS)).not.toContain('submissions');
  });

  it('public views always show; Dashboard/Admin follow user + me', () => {
    for (const id of ['discover', 'contribute', 'tutorials']) {
      const item = topbar.NAV_ITEMS.find((i) => i.id === id);
      expect(item.show(null, null), `${id} must be public`).toBe(true);
      expect(item.show(USER, null), `${id} stays public signed in`).toBe(true);
    }
    const dash = topbar.NAV_ITEMS.find((i) => i.id === 'dashboard');
    expect(dash.show(null, null)).toBe(false);
    expect(dash.show(USER, null), 'me unresolved → hidden').toBe(false);
    expect(dash.show(null, {}), 'signed out → hidden').toBe(false);
    expect(dash.show(USER, {})).toBe(true);
    const admin = topbar.NAV_ITEMS.find((i) => i.id === 'admin');
    expect(admin.show(null, null)).toBe(false);
    expect(admin.show(USER, null)).toBe(false);
    expect(admin.show(USER, {}), 'non-admin me → hidden').toBe(false);
    expect(admin.show(USER, { isAdmin: false })).toBe(false);
    expect(admin.show(USER, { isAdmin: true })).toBe(true);
    expect(admin.show(null, { isAdmin: true })).toBe(false);
  });

  it('visibleItems(user, me) filters NAV_ITEMS in config order', () => {
    expect(ids(topbar.visibleItems(null, null)))
      .toEqual(['discover', 'contribute', 'tutorials']);
    expect(ids(topbar.visibleItems(USER, {})))
      .toEqual(['discover', 'contribute', 'dashboard', 'tutorials']);
    expect(ids(topbar.visibleItems(USER, { isAdmin: true })))
      .toEqual(['discover', 'contribute', 'dashboard', 'tutorials', 'admin']);
  });
});

describe('pillSplit (max 3 visible, active always shown)', () => {
  const anon = () => topbar.visibleItems(null, null);
  const adminUser = () => topbar.visibleItems(USER, { isAdmin: true });

  it('shows the first three items and files the rest under More', () => {
    const { shown, more } = topbar.pillSplit('discover', adminUser());
    expect(ids(shown)).toEqual(['discover', 'contribute', 'dashboard']);
    expect(ids(more)).toEqual(['tutorials', 'admin']);
  });

  it('the active view always takes a visible slot, even from deep in More', () => {
    const visible = adminUser();
    for (const active of ['tutorials', 'dashboard', 'admin']) {
      const { shown, more } = topbar.pillSplit(active, visible);
      const shownIds = ids(shown);
      expect(shownIds.length, 'at most 3 pill slots').toBeLessThanOrEqual(3);
      expect(shownIds, `active ${active} must be visible`).toContain(active);
      expect(ids(more), `active ${active} must not also sit in More`)
        .not.toContain(active);
      expect([...shownIds, ...ids(more)].sort())
        .toEqual(ids(visible).sort());
    }
  });

  it('a visible active view keeps its positional slot; a deep one swaps into slot 2', () => {
    const signedIn = topbar.visibleItems(USER, {});
    const dashboard = topbar.pillSplit('dashboard', signedIn);
    expect(ids(dashboard.shown)).toEqual(['discover', 'contribute', 'dashboard']);
    expect(ids(dashboard.more)).toEqual(['tutorials']);
    const tutorials = topbar.pillSplit('tutorials', signedIn);
    expect(ids(tutorials.shown)).toEqual(['discover', 'tutorials']);
    expect(ids(tutorials.more)).toEqual(['contribute', 'dashboard']);
  });

  it('no More menu when everything fits in two slots', () => {
    const { shown, more } = topbar.pillSplit('discover', anon().slice(0, 2));
    expect(ids(shown)).toEqual(['discover', 'contribute']);
    expect(more).toEqual([]);
  });
});

describe('TopBar render structure (source-pinned — node env has no DOM)', () => {
  it('signature unchanged: App.js needs no changes', () => {
    expect(TOPBAR).toMatch(
      /export function TopBar\(\{ view, onView, user, me, onSignIn, onSignOut, onNewSim, onExport \}\)/);
  });

  it('brand mark + tagline and the .viewtoggle pill are kept', () => {
    expect(TOPBAR).toMatch(/className: 'topbar'/);
    expect(TOPBAR).toMatch(/className: 'mark'/);
    expect(TOPBAR).toMatch(/'WHAT WOULD YOU CHANGE\?'/);
    expect(TOPBAR).toMatch(/className: 'viewtoggle'/);
  });

  it('the pill wires the split helpers: shown buttons + a More dropdown', () => {
    expect(TOPBAR, 'render must consume the pure helpers')
      .toMatch(/const \{ shown, more \} = pillSplit\(view, visibleItems\(user, me\)\)/);
    expect(TOPBAR).toMatch(/shown\.map\(/);
    expect(TOPBAR).toMatch(/more\.map\(/);
    expect(TOPBAR, 'the More toggle exists only when items are hidden')
      .toMatch(/more\.length > 0/);
    expect(TOPBAR).toMatch(/'More',/);
    expect(TOPBAR, 'chevron is a real SVG, sized by .chev')
      .toMatch(/viewBox: '0 0 12 12'/);
    expect(TOPBAR, 'the ⌄ text glyph drifts off the baseline — retired')
      .not.toMatch(/⌄/);
  });

  it('pill buttons switch views; the active one is marked .on', () => {
    expect(TOPBAR).toMatch(/view === item\.id \? 'on' : ''/);
    expect(TOPBAR).toMatch(/onClick: \(\) => onView\(item\.id\)/);
  });

  it('a More pick switches the view and closes the menu', () => {
    const panel = TOPBAR.slice(TOPBAR.indexOf("className: 'more-menu'"));
    expect(panel, 'more-menu panel must exist and carry its items')
      .not.toBe('');
    expect(panel, 'More menu items switch the view')
      .toMatch(/onView\(item\.id\)/);
    expect(panel, 'picking a More item closes the menu')
      .toMatch(/onClose\(\)/);
  });

  it('account menu: avatar chip when signed in — identity header + sign out', () => {
    expect(TOPBAR).toMatch(/className: 'account-menu'/);
    expect(TOPBAR, 'avatar chip in the signed-in branch').toMatch(/user \?/);
    expect(TOPBAR, 'identity fallback chain is preserved')
      .toMatch(/user\.displayName \|\| user\.email \|\| user\.uid/);
    expect(TOPBAR, 'account menu shows the identity header')
      .toMatch(/user\.email/);
    expect(TOPBAR).toMatch(/'Sign out'/);
    expect(TOPBAR).toMatch(/onClick: onSignOut/);
  });

  it('signed out: a "Sign in with Google" ghost routes to onSignIn', () => {
    expect(TOPBAR).toMatch(/'Sign in with Google'/);
    expect(TOPBAR).toMatch(/onClick: onSignIn/);
  });

  it('right cluster: Export ghost, then auth, then exactly one primary CTA', () => {
    expect(TOPBAR).toMatch(/'Export area'/);
    expect(TOPBAR).toMatch(/onClick: onExport/);
    expect(TOPBAR).toMatch(/onClick: onNewSim/);
    expect(TOPBAR.match(/'Submit a sim'/g), 'exactly one Submit CTA')
      .toHaveLength(1);
    const cta = TOPBAR.indexOf("'Submit a sim'");
    expect(cta, 'CTA comes after Export area in the right cluster')
      .toBeGreaterThan(TOPBAR.indexOf("'Export area'"));
    expect(cta, 'CTA is the last element — after auth')
      .toBeGreaterThan(TOPBAR.indexOf("'Sign in with Google'"));
  });

  it('one generic DropdownMenu drives both menus: outside-close + Escape', () => {
    expect(TOPBAR, 'a shared menu component (plan: DropdownMenu-style)')
      .toMatch(/function DropdownMenu\(/);
    /* click-outside: a document listener registered while open, removed
     * again on cleanup */
    expect(TOPBAR).toMatch(/document\.addEventListener\(/);
    expect(TOPBAR).toMatch(/document\.removeEventListener\(/);
    expect(TOPBAR, 'the listener lifecycle is gated on the open flag')
      .toMatch(/if \(!open\) return/);
    /* Escape closes */
    expect(TOPBAR).toMatch(/keydown/);
    expect(TOPBAR).toMatch(/'Escape'/);
  });
});

describe('GitHub repo link (open-source toolbar entry)', () => {
  it('exports the public repo URL', () => {
    expect(topbar.GITHUB_URL)
      .toBe('https://github.com/judeosbert/openbengaluru');
  });

  it('renders an icon-only <a> in the brand mark, on the title row', () => {
    expect(TOPBAR, 'an anchor element, not a view-toggle button')
      .toMatch(/h\('a',/);
    expect(TOPBAR, 'href comes from the exported constant')
      .toMatch(/href: GITHUB_URL/);
    expect(TOPBAR, 'new tab').toMatch(/target: '_blank'/);
    expect(TOPBAR, 'no opener access from the embedded page')
      .toMatch(/rel: 'noreferrer noopener'/);
    expect(TOPBAR, 'icon-only → labelled for assistive tech')
      .toMatch(/'aria-label': 'GitHub'/);
    expect(TOPBAR, 'GitHub mark is a real SVG (octicon 16-grid)')
      .toMatch(/viewBox: '0 0 16 16'/);
    expect(TOPBAR, 'icon follows the text color via currentColor')
      .toMatch(/fill: 'currentColor'/);
    const at = (s) => TOPBAR.indexOf(s);
    expect(at("'OpenBengaluru '"), 'after the headline text')
      .toBeLessThan(at("'gh'"));
    expect(at("'gh'"),
      'before the tagline — the tagline wraps, so the chip shares the '
      + 'title flex line')
      .toBeLessThan(at("'WHAT WOULD YOU CHANGE?'"));
    expect(at("'gh'"), '…still inside the brand mark, before the pill')
      .toBeLessThan(at("className: 'viewtoggle'"));
  });

  it('gh icon styling: token-only icon chip + button-parity hover ring', () => {
    const base = expectRule(EXTRA, '\\.mark a\\.gh', '.mark a.gh');
    expect(base).toMatch(/display:inline-flex/);
    expect(base).toMatch(/align-items:center/);
    expect(base, 'first-placement size — 30×30 chip, 15px mark')
      .toMatch(/width:30px;height:30px/);
    expect(EXTRA).toMatch(/\.mark a\.gh svg\{[^}]*width:15px;height:15px/);
    expect(base, 'hair border like the pill chips')
      .toMatch(/border:1px solid var\(--hair\)/);
    expect(base).toMatch(/border-radius:999px/);
    expect(base).toMatch(/color:var\(--ink2\)/);
    expect(base, 'it is a link — kill the underline')
      .toMatch(/text-decoration:none/);
    const hover = expectRule(EXTRA, '\\.mark a\\.gh:hover',
      '.mark a.gh:hover');
    expect(hover).toMatch(/color:var\(--ink\)/);
    expect(hover, 'same accent ring the top bar buttons get on hover')
      .toMatch(/outline:1px solid var\(--accent\)/);
    expect(EXTRA, 'the userbox placement is retired')
      .not.toMatch(/\.userbox a\.gh/);
  });
});

describe('topbar CSS contract (EXTRA_CSS overrides, tokens only)', () => {
  it('the pill restyle wins the cascade: surface2 field, full round, hair border', () => {
    /* fragments stay BARE (no trailing \{) — lastRule appends \s*\{ itself;
     * a brace-suffixed fragment doubles it into an unmatchable pattern */
    const r = expectRule(COMBINED, '\\.viewtoggle', '.viewtoggle');
    expect(r).toMatch(/border-radius:999px/);
    expect(r).toMatch(/background:var\(--surface2\)/);
    expect(r).toMatch(/border:1px solid var\(--hair\)/);
  });

  it('active thumb: raised surface + soft shadow (replaces the accent fill)', () => {
    const r = expectRule(COMBINED, '\\.viewtoggle button\\.on',
      '.viewtoggle button.on');
    expect(r).toMatch(/background:var\(--surface\)/);
    expect(r).toMatch(/color:var\(--ink\)/);
    expect(r).toMatch(/box-shadow:var\(--shadow-sm\)/);
    expect(r, 'the accent-filled on-state is retired by this redesign')
      .not.toMatch(/var\(--on-accent\)/);
  });

  it('pill buttons flex-center their label and chevron; .chev is fixed-size', () => {
    /* the alignment fix: the label + svg chevron sit on one flex line, so
     * the chevron can never drift off the text baseline */
    const btn = expectRule(EXTRA, '\\.viewtoggle button', 'viewtoggle button');
    expect(btn).toMatch(/display:inline-flex/);
    expect(btn).toMatch(/align-items:center/);
    expect(EXTRA).toMatch(/\.chev\{[^}]*flex:none/);
  });

  it('dropdown menus: surface bg, --r-md radius, --shadow-lg, token-only', () => {
    for (const sel of ['\\.more-menu', '\\.account-menu']) {
      const r = expectRule(EXTRA, sel, sel);
      expect(r).toMatch(/background:var\(--surface\)/);
      expect(r).toMatch(/border-radius:var\(--r-md\)/);
      expect(r).toMatch(/box-shadow:var\(--shadow-lg\)/);
    }
  });

  it('brand and userbox are equal flex siblings — the pill stays centered', () => {
    /* user decision: the pill is centered in every auth state — the side
     * zones take equal flex so the pill lands dead center regardless of
     * how many actions each side carries */
    const mark = expectRule(EXTRA, '\\.mark(?![\\w-])', '.mark');
    expect(mark).toMatch(/flex:1 1 0/);
    expect(mark, 'theme serif pin must survive the layout override')
      .toMatch(/font-family:var\(--serif\)/);
    expect(mark).toMatch(/font-weight:(600|700)/);
    const userbox = expectRule(EXTRA, '\\.userbox(?![\\w-])', '.userbox');
    expect(userbox).toMatch(/flex:1 1 0/);
    expect(userbox).toMatch(/justify-content:flex-end/);
  });

  it('the tagline stacks on a second line and is never hidden', () => {
    /* user decision: WHAT WOULD YOU CHANGE? stays visible — stacked under
     * the brand name (flex-wrap + full-basis small), the hide-on-narrow
     * rule is retired */
    expect(EXTRA)
      .toMatch(/\.mark small\{[^}]*flex-basis:100%[^}]*font-family:var\(--mono\)/);
    expect(EXTRA, 'the hide rule must not come back')
      .not.toMatch(/max-width:820px/);
  });

  it('responsive: compact row <=900px, centered stack <=640px — nothing hides', () => {
    /* user decision: the bar behaves as a responsive component — one tight
     * row on narrow desktop/tablet, a three-row centered stack (brand /
     * pill / actions) on phones. Layout-only: no element is ever hidden. */
    expect(EXTRA)
      .toMatch(/@media \(max-width:900px\)\{\s*\.topbar\{padding:8px 12px/);
    expect(EXTRA).toMatch(/\.userbox > button\{[^}]*min-width:0/);
    const stack = EXTRA.slice(EXTRA.indexOf('@media (max-width:640px)'));
    expect(stack, 'the <=640px stack block must exist').toContain('@media');
    expect(stack).toMatch(/\.topbar\{[^}]*flex-wrap:wrap/);
    expect(stack)
      .toMatch(/\.topbar>:where\(\.mark,\.userbox\)\{[^}]*flex:0 0 100%/);
    expect(stack)
      .toMatch(/\.viewtoggle:where\(\*\)\{[^}]*justify-content:center/);
    expect(stack)
      .toMatch(/\.mark small:where\(\*\)\{[^}]*text-align:center/);
    expect(stack, 'the stack keeps every element visible — no display:none')
      .not.toMatch(/display:none/);
  });
});
