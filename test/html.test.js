/* Rewrite of test_mock.py test 10 for the Vite index.html, plus
 * test_app.js test 29 re-pointed at src/map/TrafficMap.js.
 *
 * Inverted assertion (intentional): the OLD index.html banned type="module";
 * the Vite index.html REQUIRES it. CDN react/leaflet/babel references are
 * gone — deps come from node_modules via the bundler.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const INDEX = path.join(PLAYER_ROOT, 'index.html');

function html() {
  return fs.readFileSync(INDEX, 'utf8');
}

// test_mock.py 10 (rewritten) --------------------------------------------------
it('index.html opens under Vite', () => {
  const h = html();
  expect(h.includes('<div id="root">')).toBe(true);
  /* classic /data.js script must appear BEFORE the module entry: classic
   * scripts block, module scripts are deferred — load order is guaranteed,
   * and the src/data.js adapter relies on it. */
  const dataM = h.match(/<script[^>]*src="\/data\.js"/);
  expect(dataM, 'index.html must load /data.js as a classic script').not.toBeNull();
  const modM = h.match(/<script[^>]*type="module"[^>]*src="\/src\/main\.js"/);
  expect(modM, 'index.html must load /src/main.js as an ES module').not.toBeNull();
  expect(h.indexOf(dataM[0]), 'data.js must load before the module entry')
    .toBeLessThan(h.indexOf(modM[0]));
  /* no CDN react/leaflet/babel, no Babel text/babel loading */
  expect(h.includes('unpkg.com'), 'index.html must not reference CDNs').toBe(false);
  expect(h).not.toMatch(/react@18[^"]*\/umd\/react\.production\.min\.js/);
  expect(h).not.toMatch(/react-dom@18[^"]*\/umd\/react-dom\.production\.min\.js/);
  expect(h).not.toMatch(/leaflet@1\.9\.4\/dist\/leaflet\.css/);
  expect(h).not.toMatch(/leaflet@1\.9\.4\/dist\/leaflet\.js/);
  expect(h).not.toMatch(/babel[^"]*standalone[^"]*\.min\.js/);
  expect(h.includes('type="text/babel"')).toBe(false);
  /* the old "no type=module" assertion, intentionally inverted */
  expect(h, 'index.html must use a module script for the app entry')
    .toMatch(/type="module"/);
});

// test_app.js 29 (re-pointed) --------------------------------------------------
it('overlay attach effect deps the entry object', () => {
  /* mergeStream swaps the entry OBJECT while keeping the id string; the
   * TrafficMap attach effect must dep the object itself or the overlay
   * engine stays bound to the pre-merge (frames-less) entry and keeps
   * drawing _synthVehicles placeholders until close+reopen. */
  const s = fs.readFileSync(path.join(PLAYER_ROOT, 'src', 'map', 'TrafficMap.js'), 'utf8');
  expect(s,
    'attach effect must re-run on the entry object: `}, [entry, scenKey, map]);`')
    .toMatch(/if \(entry\) overlay\.setSim\(entry, scenKey\);\s*else overlay\.clear\(\);\s*\}, \[entry, scenKey, map\]\);/);
  expect(s,
    'attach effect must not dep `entry && entry.id` — merge keeps the id, '
    + 'only the object changes')
    .not.toMatch(/\}, \[entry && entry\.id, scenKey, map\]\);/);
});
