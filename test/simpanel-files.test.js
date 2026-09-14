/* FILES section contract for the sidebar simulation details (SimPanel).
 * Source-regex style, per html.test.js — the vitest env is node-only (the
 * DOM-free guarantee), so UI contracts lock on source text.
 *
 * Pins:
 *  - a FILES section listing Demand File / Current Network / Proposed
 *    Network under their standardized stored names (storage.js FILE_NAMES);
 *  - downloads served from GET /api/files/:id/:name;
 *  - Proposed Network disabled with a "No approved submissions yet"
 *    tooltip until an approved wizard submission carries proposed.net.xml;
 *  - theme-styled link rows (no default-blue anchors on the dark sheet);
 *  - the section stays hidden while the file list is empty or loading. */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const panel = () => fs.readFileSync(
  path.join(PLAYER_ROOT, 'src', 'components', 'SimPanel.js'), 'utf8');

const extraCss = () => fs.readFileSync(
  path.join(PLAYER_ROOT, 'src', 'main.js'), 'utf8')
  /* stitch the EXTRA_CSS string-concatenation back into one stylesheet */
  .replace(/'\s*\+\s*'/g, '');

it('FILES section lists Demand File, Current Network and Proposed Network', () => {
  const s = panel();
  expect(s, 'Demand File row missing').toMatch(/'Demand File'/);
  expect(s, 'Current Network row missing').toMatch(/'Current Network'/);
  expect(s, 'Proposed Network row missing').toMatch(/'Proposed Network'/);
  expect(s, 'demand.rou.xml mapping missing').toMatch(/demand\.rou\.xml/);
  expect(s, 'today.net.xml mapping missing').toMatch(/today\.net\.xml/);
  expect(s, 'proposed.net.xml mapping missing').toMatch(/proposed\.net\.xml/);
});

it('each listed file downloads from /api/files/:id/:name', () => {
  const s = panel();
  expect(s).toMatch(
    /\/api\/files\/'\s*\+\s*encodeURIComponent\(entry\.id\)\s*\+\s*'\/'\s*\+\s*encodeURIComponent\(/);
});

it('Proposed Network is disabled with a tooltip until submitted', () => {
  const s = panel();
  expect(s, 'disabled row missing').toMatch(/disabled/);
  expect(s, 'tooltip text missing').toMatch(/No approved submissions yet/);
});

it('file rows are theme-styled, not default-blue anchors', () => {
  const css = extraCss();
  expect(css, '.filelink rule missing from EXTRA_CSS').toMatch(
    /\.filelink\{[^}]*color:var\(--ink[^}]*\}/);
  expect(css, 'filelink must drop underline (text-decoration:none)').toMatch(
    /\.filelink\{[^}]*text-decoration:none[^}]*\}/);
  expect(css, '.filelink.disabled rule missing').toMatch(
    /\.filelink\.disabled\{[^}]*\}/);
});

it('FILES section stays hidden while the list is empty or loading', () => {
  const s = panel();
  expect(s).toMatch(/srcFiles && srcFiles\.length/);
});
