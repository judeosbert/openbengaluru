import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSumo } from '../tools/pack_run.js';

/* runSumo error surfacing: the thrown message must carry SUMO's actual
 * error text on a SINGLE line — server.js tail() keeps only the last 8
 * lines of pack_run's stderr, and a multi-line message (with its 6-line
 * JS stack) pushes the real SUMO error lines out of that window. */

describe('runSumo error surfacing', () => {
  it('flattens a multi-line SUMO stderr tail into one line', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-runsumo-'));
    const stub = path.join(td, 'fake-sumo.sh');
    fs.writeFileSync(stub, [
      '#!/bin/sh',
      'echo "Error: something bad happened" >&2',
      'echo "Quitting (on error)." >&2',
      'exit 1',
      '',
    ].join('\n'));
    fs.chmodSync(stub, 0o755);
    const fcdOut = path.join(td, 'fcd.xml');
    const summOut = path.join(td, 'sum.xml');
    let err = null;
    try {
      runSumo(stub, 'net.net.xml', 'r.rou.xml', fcdOut, summOut, 900, null);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.message).toContain('SUMO failed:');
    expect(err.message).toContain('something bad happened');
    expect(err.message).toContain('Quitting (on error).');
    expect(err.message).not.toContain('\n');
    fs.rmSync(td, { recursive: true, force: true });
  });
});
