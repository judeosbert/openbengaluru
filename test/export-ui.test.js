/* Export flow + exportNet API source pins (plan: area export + worker
 * pool, phase 3; two-file export: export-both-files). The node vitest
 * env has no DOM (no jsdom, deliberately), so UI behavior is pinned at
 * source level — the established pattern (signin-gate / zones-ui /
 * html). Pins:
 *
 *   - the client-side convert.sh path is GONE (no convert.sh button, no
 *     convertScript/osmApiUrl references in the component; the lib module
 *     exports only the pure head the server also uses)
 *   - the component calls the authed /api/export-net wrapper (exportNet)
 *     and offers the draw-draw UX: armed draw mode, Redraw, Use this box
 *   - ONE request now returns THREE files as a .zip (net + osm + the
 *     vtypes preset, built by the shared src/lib/zip.js): exportNet hands
 *     back the Blob and the component saves it as one download
 *   - failures surface server errors verbatim + the player-server hint
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

it('api.exportNet: authed POST to /api/export-net returning the zip Blob', () => {
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

it('ExportFlow: the client-side OSM/convert.sh path is still gone', () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, 'no convert.sh anywhere').not.toMatch(/convert\.sh/);
  expect(src, 'no convertScript import/call').not.toMatch(/convertScript/);
  expect(src, 'no client-side OSM fetch (server owns osmApiUrl now)')
    .not.toMatch(/osmApiUrl/);
  /* the OSM bytes still never touch the client before the server hands
   * them over — the .osm.xml arrives IN the /api/export-net zip */
});

it('ExportFlow: downloads the server-built zip (net + osm) via exportNet', () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, 'imports the api wrapper').toMatch(
    /import\s*\{[^}]*exportNet[^}]*\}\s*from\s*'\.\.\/api\.js'/);
  expect(src, 'primary action is the zip bundle (net + osm + vtypes)')
    .toMatch(/Download \.zip \(net \+ osm \+ vtypes\)/);
  expect(src, 'calls exportNet(bbox, { name, zoom })')
    .toMatch(/exportNet\(\s*bbox\s*,\s*\{[^}]*zoom/);
  expect(src, 'saves the returned zip Blob via the generalized download')
    .toMatch(/downloadBlob\(\s*nm \+ '\.zip'/);
  expect(src, 'the saved-status names all three artifacts inside the zip')
    .toMatch(/\.net\.xml[\s\S]{0,200}\.osm\.xml[\s\S]{0,200}vtypes\.rou\.xml/);
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

it('ExportFlow: mode transitions never remove the drawn box', () => {
  const src = fs.readFileSync(EF, 'utf8');
  const gestureCleanup = src.match(/return \(\) => \{[\s\S]*?\}, \[mode, map\]\);/);
  expect(gestureCleanup, 'the mode-keyed gesture effect exists').toBeTruthy();
  expect(gestureCleanup[0], 'gesture-effect cleanup never removes the '
    + 'rect — the box survives armed -> drawn -> "Use this box" (modal)')
    .not.toMatch(/removeLayer/);
});

it('ExportFlow: the drawn box is torn down only on flow unmount', () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, 'an unmount-scoped effect removes the rect (Cancel / '
    + 'Escape / veil click)')
    .toMatch(/React\.useEffect\(\(\) => \(\) => \{[\s\S]{0,300}removeLayer[\s\S]{0,300}\}, \[map\]\);/);
});

it('ExportFlow: Redraw clears the drawn box from the map immediately', () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, 'the Redraw button removes the rect (and nulls the ref) '
    + 'right at the click — the old box never survives into armed mode')
    .toMatch(/onClick: \(\) => \{\s*if \(boxRef\.current\) \{\s*map\.removeLayer\(boxRef\.current\);\s*boxRef\.current = null;\s*\}\s*setMode\('armed'\);\s*\}/);
  expect(src, 'starting a new draw from armed still replaces any box '
    + 'that is present (the re-enter-draw-after-"Use this box" path)')
    .toMatch(/if \(boxRef\.current\) map\.removeLayer\(boxRef\.current\);/);
});

it("ExportFlow: 'Use current view' re-syncs the visible rect", () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, 'useView updates the drawn rect bounds to the current view')
    .toMatch(/const useView = \(\) => \{[\s\S]{0,500}boxRef\.current[\s\S]{0,300}setBounds/);
});

it('ExportFlow: scroll zoom stays available while the draw bar is up', () => {
  const src = fs.readFileSync(EF, 'utf8');
  const setup = src.match(/if \(mode === 'modal'\) return undefined;[\s\S]{0,400}?const el = map\.getContainer\(\);/);
  expect(setup, 'the armed/drawn effect setup block exists').toBeTruthy();
  expect(setup[0], 'entering draw mode must not disable scrollWheelZoom '
    + 'upfront — zoom works while the bar is up')
    .not.toMatch(/scrollWheelZoom\.disable/);
  expect(src, 'scroll zoom locks only during an active gesture (draw or '
    + 'move) so the box extent is stable mid-drag')
    .toMatch(/map\.dragging\.disable\(\);\s*map\.scrollWheelZoom\.disable\(\);/);
  expect(src, 'mouseup re-enables scroll zoom along with dragging')
    .toMatch(/const up = \(\) => \{[\s\S]{0,600}map\.scrollWheelZoom\.enable\(\)/);
});

it('ExportFlow: armed draw mode shows the crosshair cursor, not the palm', () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, 'entering armed draw mode pins the container cursor to '
    + 'crosshair right away — the user can draw without pressing first')
    .toMatch(/const el = map\.getContainer\(\);\s*if \(mode === 'armed'\) el\.style\.cursor = 'crosshair';/);
  expect(src, 'idle mousemove keeps the crosshair while armed (the palm '
    + 'never flickers back the moment the pointer moves)')
    .toMatch(/el\.style\.cursor = \(mode === 'drawn' && insideBox\(ev\)\)\s*\? 'move'\s*: \(mode === 'armed' \? 'crosshair' : ''\);/);
  expect(src, 'the gesture release restores the default cursor — crosshair '
    + 'is the armed-draw affordance, drawn keeps palm/move')
    .toMatch(/const up = \(\) => \{[\s\S]{0,500}el\.style\.cursor = '';/);
});

it('ExportFlow: status surfaces server errors verbatim + the player-server hint', () => {
  const src = fs.readFileSync(EF, 'utf8');
  expect(src, '401 -> sign-in hint').toMatch(/sign in to export/);
  expect(src, 'file:// or fetch failure -> run-via-server hint')
    .toMatch(/export needs the player server/);
  expect(src, 'server error text is shown, not swallowed').toMatch(
    /e\.message/);
});

/* The sign-in gate lives in the store (same popup as the submit flow) —
 * App must route the TopBar Export entry through it and render the flow
 * from store state so the gate's Google CTA can open it after sign-in. */
it('Export entry routes through the store sign-in gate', () => {
  const app = fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'components', 'App.js'), 'utf8');
  expect(app, 'TopBar Export must route through the store gate action '
    + '(signed out -> the same SignInGate popup the submit flow uses)')
    .toMatch(/onExport: store\.startExport/);
  expect(app, 'ExportFlow renders from store-held exportOpen — the gate '
    + 'CTA can open it after a successful sign-in')
    .toMatch(/store\.exportOpen && map \? h\(ExportFlow/);
  expect(app, 'flow close hands through the store')
    .toMatch(/onClose: store\.closeExport/);
});
