/* Privacy page — data-shape + commitment assertions for the pure module
 * src/lib/privacy.js, plus wiring checks pinning the public TopBar Privacy
 * toggle (against the NAV_ITEMS config the pill nav renders from), App's
 * 'privacy' overlay branch, and the static view component. Same layering as
 * test/tutorials.test.js. The copy pins are the point of the page: no data
 * collection, no tracking, no selling — a community project, stated honestly
 * (sign-in identity + uploaded sims ARE the only data handled). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LEAD, PRIVACY_SECTIONS, REPO_URL } from '../src/lib/privacy.js';
import * as topbar from '../src/components/TopBar.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

/* all page copy flattened — the commitment pins run over the joined text so
 * a rewrite cannot quietly drop one of the promises. */
const ALL = [LEAD, ...PRIVACY_SECTIONS.flatMap((s) => [s.title, ...s.paras])]
  .join('\n');

describe('privacy copy module (pure data, src/lib/privacy.js)', () => {
  it('exports a lead statement and non-empty sections with unique titles', () => {
    expect(typeof LEAD === 'string' && LEAD.trim(),
      'LEAD must be a non-empty string').toBeTruthy();
    expect(Array.isArray(PRIVACY_SECTIONS) && PRIVACY_SECTIONS.length > 0,
      'PRIVACY_SECTIONS must be a non-empty array').toBe(true);
    const titles = PRIVACY_SECTIONS.map((s) => s.title);
    expect(new Set(titles).size, 'section titles must be unique')
      .toBe(titles.length);
    for (const s of PRIVACY_SECTIONS) {
      expect(typeof s.title === 'string' && s.title.trim(),
        'every section needs a non-empty title').toBeTruthy();
      expect(Array.isArray(s.paras) && s.paras.length > 0
        && s.paras.every((p) => typeof p === 'string' && p.trim()),
      `${s.title}: paras must be non-empty strings`).toBe(true);
    }
  });

  it('states the core commitments: no collection, no tracking, no selling', () => {
    expect(ALL, 'the page must state that user data is not collected')
      .toMatch(/do not collect/i);
    expect(ALL, 'the page must state data is never sold')
      .toMatch(/never sell/i);
    expect(ALL, 'the page must rule out selling, renting and trading')
      .toMatch(/never sell, rent or trade/i);
    expect(ALL, 'the page must state there are no analytics').toMatch(/no analytics/i);
    expect(ALL, 'the page must state there are no ads').toMatch(/no ads/i);
    expect(ALL, 'the page must state there are no trackers').toMatch(/no trackers/i);
  });

  it('frames the project as community work and open source', () => {
    expect(ALL, 'the page must frame the project as community work')
      .toMatch(/community/i);
    expect(ALL, 'the page must point at the open-source code')
      .toMatch(/open source/i);
    expect(REPO_URL, 'REPO_URL must be the public GitHub repo')
      .toBe('https://github.com/judeosbert/openbengaluru');
  });

  it('is honest about the only data handled: sign-in identity + uploads', () => {
    const data = PRIVACY_SECTIONS
      .flatMap((s) => s.paras)
      .filter((p) => /google/i.test(p)).join('\n');
    expect(data, 'the sign-in paragraph must name Google')
      .toMatch(/Google/);
    expect(data, 'the sign-in paragraph must own the name/email exchange')
      .toMatch(/name and email/i);
    expect(ALL, 'the uploaded simulation files must be owned')
      .toMatch(/simulation files/i);
    expect(ALL, 'the page must state this is the complete data list')
      .toMatch(/complete list/i);
  });

  it('discloses the map tiles: OpenStreetMap serves them directly', () => {
    expect(ALL, 'the tile paragraph must name OpenStreetMap')
      .toMatch(/OpenStreetMap/i);
    expect(ALL, 'the tile paragraph must mention tile servers')
      .toMatch(/tile/i);
  });
});

/* TopBar wiring (pill redesign): Privacy is a PUBLIC entry of the NAV_ITEMS
 * config — visible signed-out, ordered after Tutorials. */
describe('TopBar wiring', () => {
  it('exposes a public Privacy toggle after Tutorials', () => {
    const { NAV_ITEMS } = topbar;
    expect(Array.isArray(NAV_ITEMS), 'TopBar must export a NAV_ITEMS config')
      .toBe(true);
    const ids = NAV_ITEMS.map((i) => i.id);
    expect(ids, "TopBar must toggle the 'privacy' view").toContain('privacy');
    expect(ids.indexOf('privacy'),
      'Privacy must come after Tutorials in the nav config')
      .toBeGreaterThan(ids.indexOf('tutorials'));
    const item = NAV_ITEMS.find((i) => i.id === 'privacy');
    expect(item.show(null, null),
      'Privacy must be public — visible signed out').toBe(true);
    expect(item.show({ uid: 'u1' }, null),
      'Privacy stays public signed in').toBe(true);
  });

  it('the active Privacy pill works signed out: swap-in + More remainder', () => {
    const visible = topbar.visibleItems(null, null);
    const { shown, more } = topbar.pillSplit('privacy', visible);
    const shownIds = shown.map((i) => i.id);
    expect(shownIds.length, 'at most 3 pill slots').toBeLessThanOrEqual(3);
    expect(shownIds, 'active privacy must be visible').toContain('privacy');
    expect(more.map((i) => i.id), 'privacy must not also sit in More')
      .not.toContain('privacy');
  });
});

/* App wiring: 'privacy' renders the PrivacyView overlay like
 * contribute/tutorials. */
it("App renders PrivacyView for the 'privacy' view", () => {
  const s = fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'components', 'App.js'), 'utf8');
  expect(s, 'App must import PrivacyView')
    .toMatch(/import \{ PrivacyView \} from '\.\/PrivacyView\.js';/);
  expect(s, "App must branch store.view === 'privacy' to PrivacyView")
    .toMatch(/store\.view === 'privacy' \? h\(PrivacyView, \{ store \}\) : null/);
});

/* the view is entirely static: no API calls, copy comes from the lib module,
 * the lead renders, and the repo link offers verification. */
it('PrivacyView is static and renders the lead + repo link', () => {
  const s = fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'components', 'PrivacyView.js'), 'utf8');
  expect(s, 'copy must come from the pure lib module')
    .toMatch(/from '\.\.\/lib\/privacy\.js'/);
  expect(s, 'no API calls — the page is entirely static')
    .not.toMatch(/fetch\(|from '\.\.\/api\.js'/);
  expect(s, 'the full-screen overlay shell (dash-veil) must render')
    .toMatch(/className: 'dash-veil'/);
  expect(s, 'the lead statement must render').toMatch(/LEAD/);
  expect(s, 'every section must render from PRIVACY_SECTIONS')
    .toMatch(/PRIVACY_SECTIONS/);
  expect(s, 'the repo link must target the exported REPO_URL')
    .toMatch(/REPO_URL/);
  expect(s, 'the repo link opens in a new tab safely')
    .toMatch(/rel: 'noreferrer'/);
});
