/* Deployment wiring: the player server must be reachable from outside the
 * host (Railway binds containers to an interface and forwards $PORT), and
 * the container image must carry SUMO — POST /api/simulate shells out to it
 * and fails at runtime (500s on every wizard submit) if the binary is
 * missing from the image.
 *
 * Pinned as text, same style as test/html.test.js pins the attach-effect
 * dep array. Docker itself is not exercised here (not available in CI/
 * sandbox); these assertions lock the contract the image must satisfy.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

function read(...parts) {
  return fs.readFileSync(path.join(PLAYER_ROOT, ...parts), 'utf8');
}

describe('deployment (server bind + container image)', () => {
  it('server.js listens on 0.0.0.0, not loopback-only', () => {
    const s = read('server.js');
    expect(s,
      'main() must bind 0.0.0.0 — Railway/PaaS networks cannot reach a '
      + '127.0.0.1-bound server')
      .toMatch(/server\.listen\(port, '0\.0\.0\.0'/);
    expect(s,
      'startup log must not claim a loopback URL the bind no longer '
      + 'matches')
      .not.toMatch(/http:\/\/127\.0\.0\.1/);
  });

  it('Dockerfile installs SUMO, builds the app, runs server.js', () => {
    const d = read('Dockerfile');
    expect(d, 'image must install the sumo binary (simulate shells it)')
      .toMatch(/apt-get[^|]*install[^|]*\bsumo\b/s);
    expect(d, 'devDependencies must be present for the vite build')
      .toMatch(/npm ci( --include=dev)?/);
    expect(d, 'static app must be built into dist/ in the image')
      .toMatch(/npm run build/);
    expect(d, 'container must start the player server (honours $PORT)')
      .toMatch(/CMD\s*\[?"node",\s*"server\.js"/);
  });

  it('.dockerignore keeps local junk out of the image context', () => {
    const i = read('.dockerignore');
    expect(i, 'node_modules must not ship in the build context')
      .toMatch(/^node_modules$/m);
    expect(i, 'local uploads must not ship in the image')
      .toMatch(/^uploads$/m);
  });
});
