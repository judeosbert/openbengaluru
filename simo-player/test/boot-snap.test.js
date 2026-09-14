/* Boot camera-jump regression: the "after a publish" snap effect in App.js
 * fired for the BOOT catalog merge too. On server origins the store's boot
 * effect merges GET /api/catalog into the catalog a moment after mount —
 * the catalog length grows, the effect reads that as "a sim was just
 * published" and animated-fits the map to the last merged entry. With the
 * intro reveal the map is only exposed at that moment, so the user watches
 * the map open and then visibly zoom/pan away ("opens zoomed, then zooms
 * out again").
 *
 * The discriminator is already stamped by catalogMerge.js: every boot-merge
 * (and preview) entry carries `apiStream`; a local publish never does.
 * The snap must skip apiStream-stamped entries — the id-change effect
 * already fits geo-locked previews/pins, so nothing is lost.
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

/* the publish-snap effect lives between its comment header and the
 * auto-snap-on-open comment */
function publishEffect(app) {
  const start = app.indexOf('after a publish');
  expect(start, 'publish-snap effect not found').toBeGreaterThanOrEqual(0);
  return app.slice(start, app.indexOf('auto-snap on open', start));
}

describe('publish-snap effect (App.js)', () => {
  it('snaps on a local publish', () => {
    const effect = publishEffect(read('src', 'components', 'App.js'));
    expect(effect, 'snap must read the last catalog entry')
      .toMatch(/store\.catalog\[store\.catalog\.length - 1\]/);
    expect(effect, 'geo-locked publish fits the downloaded bounds')
      .toMatch(/fitBounds\(/);
    expect(effect, 'anchor-only publish flies to the anchor')
      .toMatch(/flyTo\(/);
  });

  it('never snaps for boot-merged (apiStream) entries', () => {
    const effect = publishEffect(read('src', 'components', 'App.js'));
    expect(effect,
      'the snap must skip apiStream-stamped entries — boot merge and '
      + 'preview growth are not publishes')
      .toMatch(/!e\.apiStream/);
  });
});
