/* Contribute page (plan: in-app contribution guide) — data-shape assertions
 * for the pure copy module src/lib/contribute.js, plus regex-style wiring
 * checks (pattern from test/html.test.js) pinning the public TopBar Contribute
 * toggle and App's 'contribute' overlay branch. The copy itself must stay
 * honest: blurbs only reference features that exist (wizard, review queue,
 * comment threads, tools pipeline). The public TopBar Contribute toggle is
 * pinned against the NAV_ITEMS config the pill nav renders from. */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TRACKS, LEVELING_UP } from '../src/lib/contribute.js';
import * as topbar from '../src/components/TopBar.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const ROLES = TRACKS.flatMap((t) => t.roles);

/* plan: 6 tracks, 16 roles — each role name/subtitle/does/start non-empty;
 * eligibility only where it exists (Zuul). */
it('six tracks, each with a title and non-empty role list', () => {
  expect(TRACKS).toHaveLength(6);
  for (const t of TRACKS) {
    expect(typeof t.title === 'string' && t.title.trim(),
      `track ${JSON.stringify(t.title)}: title must be a non-empty string`)
      .toBeTruthy();
    expect(Array.isArray(t.roles) && t.roles.length > 0,
      `track ${t.title}: must list roles`).toBe(true);
  }
});

it('sixteen roles with the copy shape per role', () => {
  expect(ROLES).toHaveLength(16);
  for (const r of ROLES) {
    for (const f of ['name', 'subtitle', 'does', 'start']) {
      expect(typeof r[f] === 'string' && r[f].trim(),
        `${r.name || '?'}: ${f} must be a non-empty string`).toBeTruthy();
    }
    expect(r.eligibility === undefined
      || (typeof r.eligibility === 'string' && !!r.eligibility.trim()),
    `${r.name}: eligibility must be absent or a non-empty string`).toBe(true);
  }
});

/* the roster is a locked plan decision: exact names, in track order. */
it('the locked sixteen-role roster in track order', () => {
  expect(ROLES.map((r) => r.name)).toEqual([
    'Dora', 'Fix-It Felix', 'Yoda',
    'Bob the Builder', 'Dory', 'Picasso', 'Wreck-It Ralph',
    'C-3PO', 'Gandalf',
    'Paul Revere', 'Rocky',
    'Zuul',
    'Babel', 'Alfred', 'Obi-Wan', 'Scrooge McDuck',
  ]);
  expect(TRACKS.map((t) => t.title)).toEqual([
    'Model the City',
    'Build the Platform',
    'Explain the City',
    'Amplify & Advocate',
    'Guard the Gate',
    'Grow the Community',
  ]);
});

/* locked eligibility wording — precise: 5 of your own submissions reach
 * status 'active' (approved by an admin); matches the DB status flow and the
 * admin activate route. */
it('Zuul eligibility pins the 5-active threshold', () => {
  const zuul = ROLES.find((r) => r.name === 'Zuul');
  expect(zuul, 'Zuul role must exist').toBeTruthy();
  expect(zuul.eligibility,
    'eligibility must say 5 of your own submissions')
    .toMatch(/5 of your own submissions/);
  expect(zuul.eligibility).toMatch(/status 'active'/);
  expect(zuul.eligibility).toMatch(/approved by an admin/);
  expect((ROLES.filter((r) => r.eligibility)).map((r) => r.name))
    .toEqual(['Zuul']);
});

/* the leveling-up strip explains the natural path (Dora -> Felix -> Yoda)
 * and reuses the same locked Zuul threshold. */
it('leveling-up strip names the path and the Zuul threshold', () => {
  expect(typeof LEVELING_UP === 'string' && LEVELING_UP.trim()).toBeTruthy();
  expect(LEVELING_UP).toMatch(/Dora/);
  expect(LEVELING_UP).toMatch(/Fix-It Felix/);
  expect(LEVELING_UP).toMatch(/Yoda/);
  expect(LEVELING_UP).toMatch(/5 of your own submissions/);
  expect(LEVELING_UP).toMatch(/active/);
});

/* TopBar wiring (pill redesign): Contribute is a PUBLIC entry of the
 * NAV_ITEMS config — visible signed-out, ordered right after Discover
 * (the config drives both pill slots and the More menu). */
it('TopBar exposes a public Contribute toggle next to Discover', () => {
  const { NAV_ITEMS } = topbar;
  expect(Array.isArray(NAV_ITEMS), 'TopBar must export a NAV_ITEMS config')
    .toBe(true);
  const ids = NAV_ITEMS.map((i) => i.id);
  expect(ids, "TopBar must toggle the 'contribute' view").toContain('contribute');
  expect(ids.indexOf('contribute'),
    'Contribute must come after Discover in the nav config')
    .toBeGreaterThan(ids.indexOf('discover'));
  expect(NAV_ITEMS.find((i) => i.id === 'contribute').show(null, null),
    'Contribute must be public — visible signed out').toBe(true);
});

/* App wiring: 'contribute' renders the ContributeView overlay like
 * dashboard/admin. */
it("App renders ContributeView for the 'contribute' view", () => {
  const s = fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'components', 'App.js'), 'utf8');
  expect(s, 'App must import ContributeView')
    .toMatch(/import \{ ContributeView \} from '\.\/ContributeView\.js';/);
  expect(s, "App must branch store.view === 'contribute' to ContributeView")
    .toMatch(/store\.view === 'contribute' \? h\(ContributeView, \{ store \}\) : null/);
});

/* the view is entirely static: no API calls, copy comes from the lib module,
 * and the leveling-up strip renders. */
it('ContributeView is static and renders TRACKS + the leveling strip', () => {
  const s = fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'components', 'ContributeView.js'), 'utf8');
  expect(s, 'copy must come from the pure lib module')
    .toMatch(/import \{ TRACKS, LEVELING_UP \} from '\.\.\/lib\/contribute\.js';/);
  expect(s, 'no API calls — the page is entirely static')
    .not.toMatch(/fetch\(|from '\.\.\/api\.js'/);
  expect(s, 'the leveling-up strip must render').toMatch(/LEVELING UP/);
});