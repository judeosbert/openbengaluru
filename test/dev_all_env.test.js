/* Source-contract test (same pattern as the TrafficMap dep-array lock in
 * html.test.js) for tools/dev_all.js env wiring: BOTH spawned children
 * (player server + vite) must receive the .env-loaded environment, not bare
 * process.env. Regression for the 2026-09-13 crash: server.js fail-fasted on
 * missing PG* vars because dev_all.js never loaded .env.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const SRC = fs.readFileSync(
  path.join(PLAYER_ROOT, 'tools', 'dev_all.js'), 'utf8');

describe('dev_all.js env wiring', () => {
  it('spawns both children with the .env-loaded env', () => {
    expect(SRC, 'player-server spawn must use the loaded env')
      .toMatch(/env: \{ \.\.\.env, PORT: String\(port\) \}/);
    expect(SRC, 'vite spawn must use the loaded env')
      .toMatch(/env: \{ \.\.\.env, SIMO_API_PORT: String\(port\) \}/);
  });

  it('never spawns children with bare process.env', () => {
    expect(SRC, 'spawn env must not spread process.env — that is the bug')
      .not.toMatch(/env: \{ \.\.\.process\.env,/);
  });

  it('loads the shared dotenv module from the repo root .env', () => {
    expect(SRC, 'dev_all.js must import tools/dotenv.js')
      .toMatch(/from '\.\.?\/dotenv\.js'/);
    expect(SRC, 'dev_all.js must actually call the loader')
      .toMatch(/loadDotEnvFile\(/);
  });
});
