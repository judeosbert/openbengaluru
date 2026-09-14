/* Port of test_mock.py test 4 — data.js determinism — as an OPT-IN test.
 *
 * Skipped unless SIMO_REGEN=1. When enabled it shells the external generator
 * (sim/build_player.py --export-mock, untouched) twice and asserts
 * byte-stability plus equality with the committed public/data.js.
 * Run: SIMO_REGEN=1 npx vitest run test/data-regen.test.js
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const GENERATOR = path.join(PLAYER_ROOT, '..', 'sim', 'build_player.py');
const COMMITTED = path.join(PLAYER_ROOT, 'public', 'data.js');

const maybeIt = process.env.SIMO_REGEN ? it : it.skip;

describe('data regen (opt-in, SIMO_REGEN=1)', () => {
  maybeIt('generator is byte-stable and matches committed public/data.js', () => {
    if (!fs.existsSync(COMMITTED)) throw new Error('public/data.js missing: ' + COMMITTED);
    if (!fs.existsSync(GENERATOR)) throw new Error('generator missing: ' + GENERATOR);
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-regen-'));
    const outs = [path.join(td, 'a.js'), path.join(td, 'b.js')];
    for (const out of outs) {
      execFileSync('python3', [GENERATOR, '--export-mock', out], { timeout: 600000 });
      expect(fs.existsSync(out),
        'generator produced no output — is --export-mock implemented?').toBe(true);
    }
    const b1 = fs.readFileSync(outs[0]);
    const b2 = fs.readFileSync(outs[1]);
    expect(b1.equals(b2), 're-running --export-mock is not byte-stable').toBe(true);
    const committed = fs.readFileSync(COMMITTED);
    expect(committed.equals(b1),
      'committed public/data.js differs from a fresh --export-mock run').toBe(true);
  });
});
