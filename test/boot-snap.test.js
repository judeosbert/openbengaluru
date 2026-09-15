/* Boot camera-jump regression, updated for the no-fake-simulations plan.
 *
 * The OLD "after a publish" snap effect in App.js fired for the BOOT
 * catalog merge too (catalog length grew -> effect read it as a publish ->
 * animated-fit the map to the last merged entry — "opens zoomed, then
 * zooms out again"). The apiStream stamp used to discriminate, but local
 * publishes no longer exist at all: submit failures keep the wizard open
 * (nothing enters the catalog), and entries only arrive through
 * GET /api/catalog after admin activation. The dead effect is DELETED —
 * there is no catalog-growth watcher left to misfire on the boot merge.
 *
 * The only camera snap left is the id-change effect (auto-snap on open):
 * it fires on real open clicks / preview plays and fits geo-locked
 * entries to their downloaded bounds.
 *
 * Pinned as text (node env, no jsdom) — same style as test/html.test.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

describe('publish-snap effect (App.js)', () => {
  const app = () => read('src', 'components', 'App.js');

  it('the catalog-growth publish snap effect is deleted', () => {
    const s = app();
    expect(s, 'no catalog-length watcher may remain — boot merge growth '
      + 'must never move the camera')
      .not.toMatch(/prevLen/);
    expect(s, 'no length-diff snap effect dep array may remain')
      .not.toMatch(/store\.catalog\.length, map/);
    expect(s, 'no publish-snap comment block may remain')
      .not.toMatch(/after a publish/);
  });

  it('boot merge must not snap the camera (store never drives the map)', () => {
    const s = read('src', 'state', 'store.js');
    expect(s, 'the store has no map handle — the boot catalog merge can '
      + 'only mutate data, never fitBounds/flyTo')
      .not.toMatch(/fitBounds|flyTo/);
  });

  it('auto-snap on open survives for geo-locked entries', () => {
    const s = app();
    expect(s, 'the id-change effect still fits the downloaded bounds')
      .toMatch(/if \(entry && entry\.bounds\) \{\s*map\.fitBounds\(entry\.bounds/);
    expect(s, 'it must not fire while the draft wizard owns the map')
      .toMatch(/store\.draftSub\) return/);
  });
});
