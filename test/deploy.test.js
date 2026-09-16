/* Deployment wiring: the player server must be reachable from outside the
 * host (Railway binds containers to an interface and forwards $PORT), and
 * the container image must carry SUMO — POST /api/simulate and
 * /api/export-net shell out to it and fail at runtime (500s on every
 * wizard submit) if the binary is missing from the image.
 *
 * Pinned as text, same style as test/html.test.js pins the attach-effect
 * dep array. Docker itself is not exercised here (not available in CI/
 * sandbox); these assertions lock the contract the image must satisfy.
 * Railpack (railpack.json) replaced the retired Dockerfile — the image
 * assertions now pin the Railpack deploy contract.
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

  it('railpack.json installs SUMO and runs the player server', () => {
    const r = read('railpack.json');
    expect(r, 'deploy image must install the sumo binary (simulate + '
      + 'export-net shell out to it)')
      .toMatch(/"sumo"/);
    expect(r, 'deploy must start the player server (honours $PORT)')
      .toMatch(/"startCommand":\s*"node server\.js"/);
  });

  it('.dockerignore keeps local junk out of the image context', () => {
    const i = read('.dockerignore');
    expect(i, 'node_modules must not ship in the build context')
      .toMatch(/^node_modules$/m);
    expect(i, 'local uploads must not ship in the image')
      .toMatch(/^uploads$/m);
  });
});
