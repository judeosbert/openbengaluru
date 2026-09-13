/* Export flow + exportNet API source pins (plan: area export + worker
 * pool, phase 3). The node vitest env has no DOM (no jsdom, deliberately),
 * so UI behavior is pinned at source level — the established pattern
 * (signin-gate / zones-ui / html). Pins:
 *
 *   - the client-side convert.sh path is GONE (no convert.sh button, no
 *     convertScript/osmApiUrl references in the component; the lib module
 *     exports only the pure head the server also uses)
 *   - the component calls the authed /api/export-net wrapper (exportNet)
 *     and offers the draw-draw UX: armed draw mode, Redraw, Use this box
 *   - failures surface server errors verbatim + the player-server hint
 *   - api.js exportNet: authed POST, Blob response, body.error throws
 */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const API = path.join(PLAYER_ROOT, 'src', 'api.js');
const EF = path.join(PLAYER_ROOT, 'src', 'components', 'ExportFlow.js');
const LIB = path.join(PLAYER_ROOT, 'src', 'lib', 'areaExport.js');

/* ------------------------------------------------------------ lib shape */

it('areaExport lib: pure export head only — convertScript is deleted', async () => {
  const mod = await import(path.join(PLAYER_ROOT, 'src', 'lib',
    'areaExport.js'));
  expect(Object.keys(mod).sort())
    .toEqual(['osmApiUrl', 'sanitizeAreaName', 'validateBbox']);
  expect(mod.convertScript, 'the bash-script era is over').toBeUndefined();
});

/* --------------------------------------------------------------- api.js */

it('api.exportNet: authed POST to /api/export-net returning a Blob', () => {
  const src = fs.readFileSync(API, 'utf8');
  expect(src, 'exportNet wrapper exists').toMatch(/export\s+async\s+function\s+exportNet\s*\(/);
  expect(src, 'hits the server route').toMatch(/\/api\/export-net/);
  expect(src, 'authed like the other wrappers — token pulled via '
    + 'currentToken, never by components')
    .toMatch(/exportNet[\s\S]{0,600}currentToken\(\)/);
  expect(src, 'JSON body carries bbox + name + zoom')
    .toMatch(/bbox[\s\S]{0,120}name[\s\S]{0,120}zoom/);
  expect(src, 'binary response — res.blob(), NOT res.json()')
    .toMatch(/\.blob\(\)/);
  expect(src, 'non-OK surfaces the server body.error like call()')
    .toMatch(/err\.error\s*\|\|\s*'HTTP\s'\s*\+\s*res\.status/);
});

/* ------------------------------------------------------ ExportFlow pins */

it('ExportFlow: the client-side OSM/convert.sh path is gone', () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, 'no convert.sh anywhere').not.toMatch(/convert\.sh/);
  expect(src, 'no convertScript import/call').not.toMatch(/convertScript/);
  expect(src, 'no client-side OSM fetch (server owns osmApiUrl now)')
    .not.toMatch(/osmApiUrl/);
  expect(src, "no 'Download .osm.xml' button")
    .not.toMatch(/Download \.osm\.xml/);
});

it('ExportFlow: downloads the server-built .net.xml via exportNet', () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, 'imports the api wrapper').toMatch(
    /import\s*\{[^}]*exportNet[^}]*\}\s*from\s*'\.\.\/api\.js'/);
  expect(src, "primary action is the finished net download")
    .toMatch(/Download \.net\.xml/);
  expect(src, 'calls exportNet(bbox, { name, zoom })')
    .toMatch(/exportNet\(\s*bbox\s*,\s*\{[^}]*zoom/);
  expect(src, 'saves the returned Blob via the generalized download')
    .toMatch(/downloadBlob\(/);
});

it('ExportFlow: drag-draw state machine (armed -> drawn) with move + redraw', () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, "draw mode is ARMED via 'Draw a box'").toMatch(/Draw a box/);
  expect(src, 'the map gesture draws the rect: mousedown starts it, '
    + 'dragging disabled for the gesture only')
    .toMatch(/map\.dragging\.disable\(\)/);
  expect(src, 'mouseup is registered on the WINDOW (release outside the '
    + 'container is still caught)')
    .toMatch(/window\.addEventListener\('mouseup'/);
  expect(src, 'the mouseup handler re-enables dragging unconditionally')
    .toMatch(/const up = \(\) => \{[\s\S]{0,500}map\.dragging\.enable\(\)/);
  expect(src, "'Redraw' clears and re-arms — unlimited redraws")
    .toMatch(/Redraw/);
  expect(src, "'Use this box' returns to the modal with the bbox set")
    .toMatch(/Use this box/);
  expect(src, 'Escape exits draw mode').toMatch(/Escape/);
});

it('ExportFlow: status surfaces server errors verbatim + the player-server hint', () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, '401 -> sign-in hint').toMatch(/sign in to export/);
  expect(src, 'file:// or fetch failure -> run-via-server hint')
    .toMatch(/export needs the player server/);
  expect(src, 'server error text is shown, not swallowed').toMatch(
    /e\.message/);
});
