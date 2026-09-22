/* Capture page (plan: capture-leaderboard page) — data-shape assertions for
 * the pure copy module src/lib/capture.js (the three pedestrian capture-method
 * cards, the method enum the upload widget validates against, the leaderboard
 * scoring note, the competition-rules copy, and the client-side SHA-256
 * short-circuit helper), plus
 * regex-style wiring checks (pattern from contribute.test.js/tutorials.test.js)
 * pinning the public TopBar Capture toggle, App's 'capture' overlay branch,
 * the api wrappers the widget uses, and a SOURCE-ORDER check: the page must
 * render upload widget -> guide cards -> leaderboard (the locked mobile-first
 * stacking order). */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GUIDE_METHODS, METHODS, LEADERBOARD_NOTE, sha256Hex }
  from '../src/lib/capture.js';
import * as topbar from '../src/components/TopBar.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

/* ------------------------------------------------- copy module shape --- */

/* the three guide cards are a locked roster, in order (the teach-first
 * methods; the Wi-Fi card is advice, not an enum method). */
it('three guide cards with the locked titles, in order', () => {
  expect(Array.isArray(GUIDE_METHODS) && GUIDE_METHODS.length).toBe(3);
  expect(GUIDE_METHODS.map((c) => c.title)).toEqual([
    '30-second snapshot',
    'Footbridge clip',
    'Upload on Wi-Fi',
  ]);
});

/* every card carries the full copy shape: the ask (what to do), why it
 * works, and how the data is used downstream. */
it('each card has ask / whyItWorks / howItIsUsed as non-empty strings', () => {
  for (const c of GUIDE_METHODS) {
    for (const f of ['title', 'ask', 'whyItWorks', 'howItIsUsed']) {
      expect(typeof c[f] === 'string' && c[f].trim(),
        `${c.title}: ${f} must be a non-empty string`).toBeTruthy();
    }
  }
});

/* the copy must teach the actual capture protocol — each card names its
 * subject and the Wi-Fi card carries the upload advice (plan: no offline
 * queue; upload when on Wi-Fi). */
it('the copy teaches the three cards honestly', () => {
  const [snap, bridge, wifi] = GUIDE_METHODS;
  expect(snap.ask).toMatch(/30 seconds|thirty seconds/i);
  expect(bridge.ask).toMatch(/footbridge|bridge/i);
  expect(wifi.ask).toMatch(/wi-?fi/i);
});

/* the upload widget's method enum — the same ids the server validates
 * (stopwatch + other were removed: the roster is snapshot + footbridge). */
it('METHODS carries the two server-validated enum ids', () => {
  expect(METHODS).toEqual(['snapshot', 'footbridge']);
});

/* leaderboard scoring copy: 1 point per accepted capture, all-time totals. */
it('LEADERBOARD_NOTE explains the scoring', () => {
  expect(typeof LEADERBOARD_NOTE === 'string' && LEADERBOARD_NOTE.trim())
    .toBeTruthy();
  expect(LEADERBOARD_NOTE).toMatch(/1 point per accepted capture/i);
  expect(LEADERBOARD_NOTE).toMatch(/all-time/i);
});

/* client hash short-circuit: the widget pre-computes SHA-256 over the file
 * bytes via crypto.subtle (server still recomputes — never trusted). */
it('sha256Hex digests bytes to the lowercase hex digest', async () => {
  const bytes = new TextEncoder().encode('hello');
  expect(await sha256Hex(bytes))
    .toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  expect(await sha256Hex(new Uint8Array(0)))
    .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const h = await sha256Hex(new TextEncoder().encode('hello'));
  expect(h).toBe(h.toLowerCase());
});

/* ------------------------------------------------- TopBar wiring --- */

/* Capture is a PUBLIC entry of the NAV_ITEMS config — visible signed-out,
 * ordered right after Contribute (config drives pill slots + More menu). */
it('TopBar exposes a public Capture toggle after Contribute', () => {
  const { NAV_ITEMS } = topbar;
  expect(Array.isArray(NAV_ITEMS), 'TopBar must export a NAV_ITEMS config')
    .toBe(true);
  const ids = NAV_ITEMS.map((i) => i.id);
  expect(ids, "TopBar must toggle the 'capture' view").toContain('capture');
  expect(ids.indexOf('capture'),
    'Capture must come after Contribute in the nav config')
    .toBeGreaterThan(ids.indexOf('contribute'));
  expect(NAV_ITEMS.find((i) => i.id === 'capture').show(null, null),
    'Capture must be public — visible signed out').toBe(true);
});

/* ---------------------------------------------------- App wiring --- */

it("App renders CaptureView for the 'capture' view", () => {
  const s = read('src', 'components', 'App.js');
  expect(s, 'App must import CaptureView')
    .toMatch(/import \{ CaptureView \} from '\.\/CaptureView\.js';/);
  expect(s, "App must branch store.view === 'capture' to CaptureView")
    .toMatch(/store\.view === 'capture' \? h\(CaptureView, \{ store \}\) : null/);
});

/* ------------------------------------------------- api wrappers --- */

/* the upload widget's transport: raw bytes as the body, metadata as
 * URI-encoded query params, the file's MIME type as Content-Type, the
 * Firebase token in the Authorization header (token-explicit wrappers —
 * components never touch tokens), and the public leaderboard fetch. */
it('api.js exposes uploadCapture (raw body + query params) and fetchLeaderboard', () => {
  const src = read('src', 'api.js');
  expect(src, 'uploadCapture wrapper exists')
    .toMatch(/export\s+async\s+function\s+uploadCapture\s*\(/);
  expect(src, 'hits the captures route').toMatch(/\/api\/captures\?/);
  expect(src, 'authed via currentToken — token-explicit wrapper')
    .toMatch(/uploadCapture[\s\S]{0,800}currentToken\(\)/);
  expect(src, 'RAW body — the file bytes ride as the request body')
    .toMatch(/body:\s*file/);
  expect(src, 'file MIME type rides as Content-Type')
    .toMatch(/'Content-Type':\s*file\.type/);
  expect(src, 'metadata is URI-encoded into the query string')
    .toMatch(/encodeURIComponent/);
  expect(src, 'public leaderboard fetch — no token')
    .toMatch(/export\s+function\s+fetchLeaderboard\s*\(\)/);
  expect(src).toMatch(/\/api\/captures\/leaderboard/);
});

/* ------------------------------------------------ CaptureView pins --- */

const VIEW = () => read('src', 'components', 'CaptureView.js');

it('CaptureView uses the dash shell and closes back to discover', () => {
  const s = VIEW();
  expect(s, 'the dash shell (ContributeView pattern)').toMatch(/dash-veil/);
  expect(s).toMatch(/dash-head/);
  expect(s, "the page title").toMatch(/'CAPTURE'/);
  expect(s, 'Close returns to discover').toMatch(
    /store\.setView\('discover'\)/);
});

/* gating: page is public but the upload widget needs the signed-in user —
 * signed out, an inline sign-in prompt routes through the store's existing
 * Google flow (store.signIn), NOT a fetch. */
it('the upload widget gates on store.user with the existing sign-in flow', () => {
  const s = VIEW();
  expect(s, 'a signed-out branch exists').toMatch(/store\.user/);
  expect(s, 'the sign-in prompt reuses the store sign-in action')
    .toMatch(/store\.signIn/);
  expect(s, 'the prompt says what signing in unlocks')
    .toMatch(/sign in to upload/i);
});

/* the widget: method radio-chips (not a select), junction input, the file
 * input keeps accept WITHOUT a forced capture attribute, datetime-local
 * prefilled from file.lastModified, client hash — NO location capture
 * (removed: not required). */
it('the widget pins the upload controls', () => {
  const s = VIEW();
  expect(s, 'method picker renders from the pure enum — large-tap radio-chips')
    .toMatch(/METHODS\.map\(/);
  expect(s, 'radio chips, not a <select>').toMatch(/type: 'radio'/);
  expect(s, 'the file input accepts video and image').toMatch(
    /accept:\s*'video\/\*,image\/\*'/);
  expect(s, 'NO forced live-capture attribute — just-recorded clips stay '
    + 'pickable').not.toMatch(/capture:\s*'environment'|capture:\s*'user'/);
  expect(s, 'capturedAt uses a datetime-local input')
    .toMatch(/datetime-local/);
  expect(s, 'no geolocation — location capture was removed from the form')
    .not.toMatch(/navigator\.geolocation/);
  expect(s, 'no location chip — the geo copy is gone entirely').not.toMatch(
    /location captured|no location/);
  expect(s, 'the client hash short-circuit goes through the shared '
    + 'sha256Hex helper (crypto.subtle itself lives in the lib module)')
    .toMatch(/sha256Hex\(/);
});

/* the leaderboard: top 10 collapsed, "show all" expands, quiet failure. */
it('the leaderboard renders top 10 with a show-all expand + quiet failure', () => {
  const s = VIEW();
  expect(s, 'collapsed to the top 10 by default').toMatch(/slice\(0,\s*10\)/);
  expect(s, 'an expand control exists').toMatch(/show all/i);
  expect(s, 'fetch failure renders the quiet note — no error UI')
    .toMatch(/leaderboard unavailable/i);
});

/* ------------------------------------------------- source order --- */

/* the section order in source (the rendered page shows the upload pane's
 * sections under the Upload tab, the leaderboard under its tab — see the
 * tabs pins below): upload widget -> guide cards -> leaderboard. The
 * markers are the section headings; checking their positions AFTER the
 * import block pins the render order in source. */
it('page stacks in the fixed order: widget -> guide cards -> leaderboard', () => {
  const s = VIEW();
  const body = s.slice(s.lastIndexOf("from '"));
  const at = (m) => body.indexOf(m);
  expect(at('UPLOAD A CAPTURE'), 'the upload widget section must render')
    .toBeGreaterThan(-1);
  expect(at('CAPTURE METHODS'), 'the guide cards section must render')
    .toBeGreaterThan(-1);
  expect(at('LEADERBOARD'), 'the leaderboard section must render')
    .toBeGreaterThan(-1);
  expect(at('CAPTURE METHODS'),
    'guide cards come after the upload widget')
    .toBeGreaterThan(at('UPLOAD A CAPTURE'));
  expect(at('LEADERBOARD'),
    'the leaderboard comes last').toBeGreaterThan(at('CAPTURE METHODS'));
});

/* the copy comes from the pure lib module and the data from the api
 * wrappers — no direct fetch() in the component. */
it('CaptureView pulls copy from the lib module and data from api.js', () => {
  const s = VIEW();
  expect(s, 'guide copy must come from the pure lib module').toMatch(
    /from '\.\.\/lib\/capture\.js'/);
  expect(s, 'the transport lives in api.js — no direct fetch in the view')
    .not.toMatch(/fetch\(/);
  expect(s, 'the guide cards render').toMatch(/GUIDE_METHODS\.map\(/);
  expect(s, 'the scoring note renders').toMatch(/LEADERBOARD_NOTE/);
});

/* ------------------------------------------- redesign (design reference) ---
 * The capture page adopts the /tmp/design.html reference: a phone-shell
 * panel with a brand header + scroll body, a dropzone upload card with a
 * selected-file row, accordion guide cards, a ranked leaderboard with
 * initials avatars, and a Google sign-in bottom sheet. Every pin below is
 * a source-order/regex pin in the house style. */
it('the dash becomes the phone shell: brand header + scroll body', () => {
  const s = VIEW();
  expect(s, 'shell override class on the dash panel')
    .toMatch(/'dash capture-dash'/);
  expect(s, 'brand badge sits in the dash header').toMatch(/capture-brand/);
  expect(s, 'the page title stays CAPTURE').toMatch(/capture-title/);
  expect(s, 'scrollable body wrapper').toMatch(/capture-body/);
});

it('the dropzone drives the file picker signed-in, the sign-in sheet not', () => {
  const s = VIEW();
  expect(s, 'the hidden file input is ref-tappable from the dropzone')
    .toMatch(/fileRef/);
  expect(s, 'the sign-in bottom sheet state').toMatch(/sheetOpen/);
  expect(s, 'the sheet renders as capture-sheet').toMatch(/capture-sheet/);
  expect(s, 'the sheet Google CTA reuses the store sign-in action')
    .toMatch(/store\.signIn\(\)/);
});

it('the upload card is a dropzone with a selected-file row + remove control', () => {
  const s = VIEW();
  expect(s, 'the dropzone label wraps the picker').toMatch(/capture-drop/);
  expect(s, 'a selected-file row shows name + size').toMatch(
    /capture-file-row/);
  expect(s, 'a remove control clears the pick').toMatch(/Remove/);
});

it('guide cards render as accordions', () => {
  const s = VIEW();
  expect(s, 'accordion shell classes').toMatch(/capture-acc/);
  expect(s, 'per-item accordion class').toMatch(/capture-acc-item/);
});

it('leaderboard rows get initials avatars and a rank-1 highlight', () => {
  const s = VIEW();
  expect(s, 'initials avatar helper from the name').toMatch(/initials/);
  expect(s, 'per-row avatar class').toMatch(/capture-avatar/);
  expect(s, 'rank-1 highlight row').toMatch(/capture-lb-top/);
});

/* ----------------------------------------------- redesign CSS (EXTRA_CSS) --- */

/* EXTRA_CSS extraction — same evaluation trick as test/theme.test.js. */
const MAIN = read('src', 'main.js');
const EXTRA = (() => {
  const start = MAIN.indexOf("const EXTRA_CSS = ''");
  expect(start, 'main.js must define EXTRA_CSS as a string concat')
    .toBeGreaterThanOrEqual(0);
  const end = MAIN.indexOf('const __simoStyle', start);
  const expr = MAIN.slice(MAIN.indexOf('=', start) + 1,
    MAIN.lastIndexOf(';', end));
  return new Function('return (' + expr + ');')();
})();

it('the redesign ships its CSS block in EXTRA_CSS with the shell classes', () => {
  for (const sel of ['.capture-dash', '.capture-head', '.capture-title',
    '.capture-body', '.capture-sheet', '.capture-drop',
    '.capture-file-row', '.capture-acc-body', '.capture-avatar',
    '.capture-lb-top']) {
    expect(EXTRA, `${sel} styled in EXTRA_CSS`).toMatch(
      new RegExp(sel.replace(/\./g, '\\.') + '[^{]*\\{'));
  }
});

it('the capture redesign CSS is token-only (no raw hex colors)', () => {
  /* every rule touching a .capture-* selector must color through the
   * Paper custom properties — the theme contract for this page. */
  const re = /(?:^|\n)([^{}\n]*\.capture-[^{}\n]*)\{([^}]*)\}/g;
  let m, seen = 0;
  while ((m = re.exec(EXTRA)) !== null) {
    seen += 1;
    expect(m[2], `rule ${m[1].trim()} must be token-only`)
      .not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  }
  expect(seen, 'the redesign ships a real capture CSS block')
    .toBeGreaterThan(10);
});

/* ------------------------------------- mobile takeover + tabs (plan) ---
 * On mobile (the house <=900px breakpoint, same as the SimPanel bottom
 * sheet) the capture page takes over the full screen: the topbar steps
 * aside while the capture view is open and the dash fills the phone.
 * The upload and leaderboard render as tabs (Upload open by default) at
 * EVERY width — the same tab swap on desktop, not a mobile-only layout. */

it('tabs: Upload | Leaderboard with upload open by default', () => {
  const s = VIEW();
  expect(s, 'the tab state defaults to upload').toMatch(
    /useState\('upload'\)/);
  expect(s, 'the tab bar renders').toMatch(/capture-tabs/);
  expect(s, 'the tab buttons carry the capture-tab class').toMatch(
    /'capture-tab' \+/);
  expect(s, 'the tab state is exposed for assistive tech')
    .toMatch(/aria-selected/);
  expect(s, 'the active tab rides the dash root as data-tab')
    .toMatch(/'data-tab': tab/);
  const atUpload = s.indexOf("'Upload'");
  const atLb = s.indexOf("'Leaderboard'");
  expect(atUpload, 'the Upload tab exists').toBeGreaterThan(-1);
  expect(atLb, 'the Leaderboard tab exists').toBeGreaterThan(-1);
  expect(atUpload, 'Upload is the first tab (default)').toBeLessThan(atLb);
  expect((s.match(/capture-pane-upload/g) || []).length,
    'the upload widget + both guide-card nodes carry the upload pane class')
    .toBeGreaterThanOrEqual(3);
  expect((s.match(/capture-pane-leaderboard/g) || []).length,
    'the leaderboard section carries the leaderboard pane class')
    .toBeGreaterThanOrEqual(1);
});

it('tabs swap panes at EVERY width; the mobile block keeps the takeover', () => {
  /* the capture mobile block is the LAST media query in EXTRA_CSS — slice
   * from it so the pins read the mobile rules and nothing else */
  const mobStart = EXTRA.lastIndexOf('@media (max-width:900px)');
  const head = EXTRA.slice(0, mobStart);
  const mob = EXTRA.slice(mobStart);
  expect(mob, 'the capture mobile block uses the house 900px breakpoint')
    .toContain('@media (max-width:900px)');
  /* universal section (outside the mobile block): the tab bar shows and
   * the data-tab rules swap the panes — desktop gets the same tabs, not
   * a stacked layout */
  expect(head, 'the tab bar is visible on desktop too').toMatch(
    /\.capture-tabs\{display:flex/);
  expect(head, 'the upload pane hides on the leaderboard tab').toMatch(
    /\.capture-dash\[data-tab='leaderboard'\] \.capture-pane-upload\{display:none\}/);
  expect(head, 'the leaderboard pane hides on the upload tab').toMatch(
    /\.capture-dash\[data-tab='upload'\] \.capture-pane-leaderboard\{display:none\}/);
  expect(head, 'the takeover rules stay inside the mobile block')
    .not.toMatch(/topbar-under-capture/);
  /* mobile block: only the takeover tweaks remain (full-bleed dash,
   * topbar aside) — the tab rules are deduped into the universal section */
  expect(mob, 'the dash fills the phone screen').toMatch(
    /\.capture-dash\{[^}]*width:100%;max-height:100%;height:100%/);
  expect(mob, 'the topbar steps aside under the capture takeover')
    .toMatch(/\.topbar-under-capture\{display:none\}/);
  expect(mob, 'the tab rules are deduped out of the mobile block')
    .not.toMatch(/capture-tabs|data-tab/);
});

/* ------------------------------------------- direct /capture.html route --- */

it('capture.html is a Vite entry that boots straight into the capture view', () => {
  const h = read('capture.html');
  expect(h.includes('<div id="root">')).toBe(true);
  const dataM = h.match(/<script[^>]*src="\/data\.js"/);
  expect(dataM, 'classic /data.js before the module entry').not.toBeNull();
  const modM = h.match(/<script[^>]*type="module"[^>]*src="\/src\/main\.js"/);
  expect(modM, 'module entry /src/main.js').not.toBeNull();
  expect(h.indexOf(dataM[0]), 'data.js must load before the module entry')
    .toBeLessThan(h.indexOf(modM[0]));
  expect(h, 'no CDN references').not.toMatch(/unpkg\.com|cdn\.tailwindcss\.com/);
  expect(h, 'boot marker selects the capture view')
    .toMatch(/window\.__SIMO_VIEW\s*=\s*'capture'/);
  expect(h.indexOf('__SIMO_VIEW'),
    'the boot marker must run before the module entry')
    .toBeLessThan(h.indexOf(modM[0]));
  expect(h, 'page title').toMatch(/<title>CAPTURE/);
  expect(h, 'pre-paint shell mirrors the Paper theme ground')
    .toMatch(/#F7F1E7/);
  expect(h, 'Fraunces + Inter fonts wired like index.html').toMatch(
    /fonts\.googleapis\.com\/css2\?family=Fraunces/);
  expect(h, 'the shell pre-paint uses the Inter body stack').toMatch(
    /font-family:"Inter",-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif/);
});

it('the store boots into the marker view (capture.html deep link)', () => {
  const s = read('src', 'state', 'store.js');
  expect(s, 'initial view reads the boot marker, defaulting to discover')
    .toMatch(/__SIMO_VIEW/);
  expect(s, 'the default view stays discover').toMatch(/'discover'/);
});

it('the build bundles capture.html as a second MPA entry', () => {
  const s = read('vite.config.js');
  expect(s, 'rollupOptions.input lists capture.html').toMatch(/capture\.html/);
  expect(s, 'index.html stays the primary entry').toMatch(/index\.html/);
});

it('the player server aliases /capture to capture.html', () => {
  const s = read('server.js');
  expect(s, "serveStatic maps '/capture' -> '/capture.html'")
    .toMatch(/p === '\/capture'/);
});

/* ------------------------------------- competition rules popup (plan) ---
 * A "Rules" text link sits in the top header bar, right of the CAPTURE
 * heading (between the title and the Close control); tapping it opens a
 * popup over the dash with the competition rules — the copy rides in the
 * pure lib module, verbatim. */

/* the copy-shape tests import dynamically so a missing export shows up
 * as THIS test's red, not a link error for the whole file. */
it('the lib module exports the competition rules copy', async () => {
  const mod = await import('../src/lib/capture.js');
  expect(mod.COMPETITION_RULES,
    'COMPETITION_RULES must be exported from src/lib/capture.js')
    .toBeTruthy();
});

it('the rules copy: title + the eight numbered sections, in order', async () => {
  const { COMPETITION_RULES } = await import('../src/lib/capture.js');
  expect(COMPETITION_RULES.title)
    .toBe('OpenBengaluru Capture — Competition Rules');
  expect(COMPETITION_RULES.sections.map((s) => s.heading)).toEqual([
    '1. The Challenge',
    '2. Competition Period',
    '3. How Points Work',
    '4. Quality Over Quantity',
    '5. Validation',
    '6. Winner',
    '7. Fair Play',
    '8. The Bigger Goal',
  ]);
});

it('the rules copy pins the competition terms verbatim', async () => {
  const { COMPETITION_RULES } = await import('../src/lib/capture.js');
  const flat = JSON.stringify(COMPETITION_RULES);
  expect(flat, 'the challenge framing').toMatch(
    /real-world data to OpenBengaluru/);
  expect(flat, 'the 21-day period').toMatch(/run for \*\*21 days\*\*/);
  expect(flat, 'dates announced on the page').toMatch(
    /announced on the OpenBengaluru Capture page/);
  expect(flat, 'points only for accepted submissions').toMatch(
    /only for accepted submissions/);
  expect(flat, 'zero points for rejected/dupes').toMatch(/\*\*0 points\*\*/);
  expect(flat, 'quality over quantity').toMatch(
    /low-quality or duplicate entries will not improve your score/);
  expect(flat, 'points only after validation').toMatch(
    /only after it has been accepted/);
  expect(flat, 'the winner term').toMatch(/highest number of valid points/);
  expect(flat, 'the prize').toMatch(/Prize: ₹500 voucher/);
  expect(flat, 'the tie-break').toMatch(
    /number of accepted submissions, followed by the acceptance rate/);
  expect(flat, 'fair-play bans fabrication').toMatch(
    /Submit fabricated observations/);
  expect(flat, 'the bigger goal').toMatch(
    /open, community-driven dataset of Bengaluru/);
  /* lib-purity contract — no DOM-global word may ride in the copy */
  expect(flat).not.toMatch(/\b(document|window|localStorage)\b/);
});

it('every rules section carries heading + p/ul blocks', async () => {
  const { COMPETITION_RULES } = await import('../src/lib/capture.js');
  for (const sec of COMPETITION_RULES.sections) {
    expect(typeof sec.heading === 'string' && sec.heading.trim(),
      `${sec.heading}: heading must be a non-empty string`).toBeTruthy();
    expect(Array.isArray(sec.blocks) && sec.blocks.length,
      `${sec.heading}: at least one block`).toBeGreaterThan(0);
    for (const b of sec.blocks) {
      expect(b.p || b.ul,
        `${sec.heading}: a block is a paragraph or a bullet list`)
        .toBeTruthy();
      if (b.ul) {
        expect(Array.isArray(b.ul) && b.ul.length,
          `${sec.heading}: a bullet block has items`).toBeGreaterThan(0);
      }
    }
  }
});

it('the Rules link sits in the header bar, right of the CAPTURE title', () => {
  const s = VIEW();
  const atTitle = s.indexOf("'capture-title'");
  const atLink = s.indexOf('capture-rules-link');
  const atClose = s.indexOf("store.setView('discover')");
  expect(atTitle, 'the header title exists').toBeGreaterThan(-1);
  expect(atLink, 'the rules link exists').toBeGreaterThan(-1);
  expect(atClose, 'the header Close exists').toBeGreaterThan(-1);
  expect(atLink, 'the rules link renders inside the header row, right of '
    + 'the CAPTURE heading').toBeGreaterThan(atTitle);
  expect(atLink, 'the link sits between the title and the Close control')
    .toBeLessThan(atClose);
  expect(s, 'the link is a Rules text control').toMatch(
    /capture-rules-link[\s\S]{0,200}'Rules'/);
  expect(s, 'the popup open state exists').toMatch(
    /const \[rulesOpen, setRulesOpen\] = React\.useState\(false\)/);
  expect(s, 'the link opens the popup').toMatch(
    /onClick: \(\) => setRulesOpen\(true\)/);
});

it('the rules popup renders the lib copy with a close control', () => {
  const s = VIEW();
  expect(s, 'the popup copy comes from the pure lib module')
    .toMatch(/COMPETITION_RULES/);
  expect(s, 'the popup shell is a dialog over the dash')
    .toMatch(/capture-rules-veil/);
  expect(s, 'outside-tap closes the popup like the sign-in sheet')
    .toMatch(/ev\.target === ev\.currentTarget/);
  expect(s, 'the popup panel class').toMatch(/capture-rules-pop/);
  expect(s, 'the popup closes via the X control').toMatch(/capture-rules-x/);
  expect(s, 'sections render headings').toMatch(/capture-rules-h/);
  expect(s, 'no transport — the view still never fetches directly')
    .not.toMatch(/fetch\(/);
});

it('the rules popup ships token-only CSS in EXTRA_CSS', () => {
  for (const sel of ['.capture-rules-link', '.capture-rules-veil',
    '.capture-rules-pop', '.capture-rules-head', '.capture-rules-body',
    '.capture-rules-h', '.capture-rules-p', '.capture-rules-ul']) {
    expect(EXTRA, `${sel} styled in EXTRA_CSS`).toMatch(
      new RegExp(sel.replace(/\./g, '\\.') + '[^{]*\\{'));
  }
  /* the long copy scrolls inside the popup — the dash never scrolls */
  expect(EXTRA.match(/\.capture-rules-body\{[^}]*\}/)[0])
    .toMatch(/overflow-y:auto/);
});

/* ------------------------------------------------- CTA removal (plan) ---
 * The sticky bottom CTA bar was a duplicate entry point (the dropzone
 * taps the picker, the form carries the sign-in prompt) — it is removed
 * from the view and from EXTRA_CSS entirely. */

it('the sticky bottom CTA is gone — the dropzone is the single CTA', () => {
  const s = VIEW();
  expect(s, 'the capture-cta bar is removed from the view')
    .not.toMatch(/capture-cta/);
  expect(EXTRA, 'the CTA CSS block is removed from EXTRA_CSS too')
    .not.toMatch(/\.capture-cta/);
  /* the dropzone + form keep their entry points */
  expect(s, 'the dropzone still opens the picker').toMatch(/openPicker/);
  expect(s, 'the sign-in prompt stays in the form').toMatch(
    /Sign in to upload/);
});

/* ------------------------------------------- upload success takeover ---
 * An accepted upload swaps the WHOLE popup body for a success moment
 * ("Upload Successful" instead of the form — the redundant toast goes
 * with it), then auto-advances to the Leaderboard tab. */

it('the upload success state exists and replaces the whole body', () => {
  const s = VIEW();
  expect(s, 'success state exists').toMatch(
    /const \[success, setSuccess\] = React\.useState\(false\)/);
  expect(s, 'the accepted upload flips the success state')
    .toMatch(/setSuccess\(true\)/);
  expect(s, 'the body swaps the form for the success card').toMatch(
    /const bodyKids = success\s*\?\s*\[successCard\]/);
  expect(s, 'the normal sections return otherwise').toMatch(
    /\[uploadCard, methodsSection, leaderboardSection\]/);
  expect(s, 'the success card title says Upload Successful').toMatch(
    /'Upload Successful'/);
  expect(s, 'the success card carries its classes')
    .toMatch(/capture-success-title/);
  expect(s, 'the redundant upload toast is superseded by the success card')
    .not.toMatch(/capture uploaded — 1 point/);
});

it('the success moment auto-advances to the leaderboard tab', () => {
  const s = VIEW();
  expect(s, 'the auto-advance delay constant').toMatch(/SUCCESS_MS/);
  expect(s, 'a setTimeout drives the advance').toMatch(/setTimeout/);
  expect(s, 'the advance lands on the leaderboard tab').toMatch(
    /setTab\('leaderboard'\)/);
  expect(s, 'the timer is cleaned up').toMatch(/clearTimeout/);
});

it('the success moment ships token-only CSS in EXTRA_CSS', () => {
  for (const sel of ['.capture-success', '.capture-success-glyph',
    '.capture-success-title', '.capture-success-sub']) {
    expect(EXTRA, `${sel} styled in EXTRA_CSS`).toMatch(
      new RegExp(sel.replace(/\./g, '\\.') + '[^{]*\\{'));
  }
});