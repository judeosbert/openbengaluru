/* Dev wiring: `npm run dev` must bring up BOTH halves of the app — the
 * vite dev server (UI) and the player server (server.js, /api/simulate).
 *
 * The wizard POSTs to a relative /api/simulate (src/state/store.js), so on
 * the vite origin the dev server must proxy /api to the player server, and
 * the dev script must start both processes together. Without this, a wizard
 * submit on :5173 silently degrades to the geometry-only preview
 * ("server simulation failed — published preview only").
 *
 * Pinned as text, same style as test/html.test.js pins the TrafficMap
 * attach-effect dep array.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const pkg = JSON.parse(
  fs.readFileSync(path.join(PLAYER_ROOT, 'package.json'), 'utf8'));

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

describe('dev wiring (vite + player server)', () => {
  it('npm run dev starts the launcher that runs both processes', () => {
    expect(pkg.scripts.dev,
      'dev script must route through the combined launcher')
      .toMatch(/tools\/dev_all\.js/);
    const launcher = read('tools', 'dev_all.js');
    expect(launcher, 'launcher must spawn the player server (server.js)')
      .toMatch(/server\.js/);
    expect(launcher, 'launcher must spawn vite').toMatch(/vite/);
  });

  it('vite dev server proxies /api to the player server', () => {
    const c = read('vite.config.js');
    expect(c, 'vite config must define a dev-server proxy for /api')
      .toMatch(/server:\s*\{[\s\S]*proxy[\s\S]*['"]\/api['"]/);
    expect(c, 'proxy target must default to the player server port 8787')
      .toMatch(/8787/);
  });
});
