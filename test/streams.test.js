/* Port of phase2/test_streams.py tests 1-3 — per-entry stream payloads:
 * data.js must not embed BALAGERE_STREAM, the Balagere JSONP stream file
 * must exist and parse, and late frames must carry real vehicles. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readStreamPayload, countStreamVehicles } from './helpers/streamPayload.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

// test_streams.py 1 -----------------------------------------------------------
it('data.js has no balagere stream', () => {
  const src = fs.readFileSync(path.join(PLAYER_ROOT, 'public', 'data.js'), 'utf8');
  expect(src.includes('BALAGERE_STREAM'),
    'public/data.js still embeds BALAGERE_STREAM; frames must move to '
    + 'public/streams/balagere-t-junction.js').toBe(false);
});

// test_streams.py 2 -----------------------------------------------------------
it('stream file exists and parses', () => {
  const p = path.join(PLAYER_ROOT, 'public', 'streams', 'balagere-t-junction.js');
  expect(fs.existsSync(p), `missing ${p}`).toBe(true);
  const src = fs.readFileSync(p, 'utf8');
  const m = src.match(
    /^window\.__simoStreamCallback\('balagere-t-junction',\s*(\{.*\})\);\s*$/s);
  expect(m, "stream file must call "
    + "window.__simoStreamCallback('balagere-t-junction', {...})").not.toBeNull();
  const payload = JSON.parse(m[1]);
  expect(payload.nFrames).toBe(900);
  expect(payload).toHaveProperty('bounds');
  for (const k of ('today proposed').split(' ')) {
    expect(payload.scenarios, `${k}: scenario missing`).toHaveProperty(k);
    expect(payload.scenarios[k], `${k}: no frames`).toHaveProperty('frames');
    const raw = Buffer.from(payload.scenarios[k].frames, 'base64');
    expect(raw.length > 1000, `${k}: frames blob too small`).toBe(true);
  }
});

// test_streams.py 3 -----------------------------------------------------------
it('stream vehicle counts match legacy', () => {
  /* Late-frame vehicle counts must be >0 (real data, not empty). */
  const payload = readStreamPayload('balagere-t-junction');
  for (const k of ('today proposed').split(' ')) {
    const n = countStreamVehicles(payload.scenarios[k].frames, 899);
    expect(n > 0, `${k}: frame 899 has 0 vehicles`).toBe(true);
  }
});
