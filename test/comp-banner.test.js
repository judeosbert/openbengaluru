/* Competition countdown banner (plan) — a small red strip, full width,
 * directly under the topbar (the top of the banner starts at the bottom
 * of the header): App renders it as the shell sibling between TopBar and
 * the map context, styled token-only in EXTRA_CSS. Regex pins in the
 * house style. */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

const APP = read('src', 'components', 'App.js');
const MAIN = read('src', 'main.js');

/* EXTRA_CSS extraction — same evaluation trick as test/capture.test.js. */
const EXTRA = (() => {
  const start = MAIN.indexOf("const EXTRA_CSS = ''");
  expect(start, 'main.js must define EXTRA_CSS as a string concat')
    .toBeGreaterThanOrEqual(0);
  const end = MAIN.indexOf('const __simoStyle', start);
  const expr = MAIN.slice(MAIN.indexOf('=', start) + 1,
    MAIN.lastIndexOf(';', end));
  return new Function('return (' + expr + ');')();
})();

it('App renders the banner between the TopBar and the map context', () => {
  const atTopBar = APP.indexOf('h(TopBar, {');
  const atBanner = APP.indexOf("'comp-banner'");
  const atMapWrap = APP.indexOf("className: 'map-wrap'");
  expect(atTopBar, 'the TopBar renders').toBeGreaterThan(-1);
  expect(atBanner, 'the banner element exists').toBeGreaterThan(-1);
  expect(atMapWrap, 'the map wrap exists').toBeGreaterThan(-1);
  expect(atBanner, 'the banner sits after the TopBar in source')
    .toBeGreaterThan(atTopBar);
  expect(atBanner, 'the banner sits before the map context in source')
    .toBeLessThan(atMapWrap);
});

it('the banner carries the countdown copy', () => {
  expect(APP, 'the banner text').toMatch(/'Capture Competition will be live from  Sep 25th - Oct 16th. Upload and top the leaderboard for the prize!'/);
});

it('the banner is a small red full-width strip, token-only', () => {
  const rule = EXTRA.match(/\.comp-banner\{[^}]*\}/);
  expect(rule, '.comp-banner styled in EXTRA_CSS').not.toBeNull();
  const css = rule[0];
  expect(css, 'red banner background').toMatch(/background:var\(--red\)/);
  expect(css, 'flex:none — a strip in the shell column')
    .toMatch(/flex:none/);
  expect(css, 'light text on the red ground').toMatch(
    /color:var\(--on-accent\)/);
  expect(css, 'token-only — no raw hex in the banner rule')
    .not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
});
