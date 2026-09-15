/* Port of test_mock.py test 7 (upload chip classification). The local
 * approveDraft/defaultSimMeta publish path is GONE — submissions run the
 * real SUMO pipeline on the player server and the entry comes back through
 * GET /api/catalog (never a fabricated catalog entry). src/lib/draft.js
 * keeps only the id helpers (slugTitle/entryIdFor), pinned by
 * test/submit.test.js via buildSimulateRequest. */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyUploadFile } from '../src/lib/netxml.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const FIXDIR = path.join(PLAYER_ROOT, 'test', 'fixtures');

// test_mock.py 7 (harness "chips" command -> direct classifier calls) ----------
it('bundle placeholder roundtrip', () => {
  const fixtures = ['sample.rou.xml', 'sample.net.xml', 'sample.sumocfg', 'notes.txt'];
  for (const f of fixtures) {
    expect(fs.existsSync(path.join(FIXDIR, f)), `fixture missing: ${f}`).toBe(true);
  }
  const pairs = fixtures.map((f) => [f, fs.statSync(path.join(FIXDIR, f)).size]);
  pairs.push(['UPPER.ROU.XML', 12]);      // case-insensitive extension
  const out = pairs.map(([name, size]) => classifyUploadFile(name, size));
  expect(out.length).toBe(pairs.length);
  const kinds = out.map((r) => (r == null ? null : r.kind));
  expect(kinds, `classifier results: ${JSON.stringify(kinds)}`)
    .toEqual(['routes', 'network', null, null, 'routes']);
  for (const r of out) {
    if (r === null) continue;   // .sumocfg / notes.txt rejected by classifier
    expect(r.size, `${r.name}: size must survive`).toBeGreaterThan(0);
    expect(r).toHaveProperty('name');
  }
});

it('draft lib keeps only the id helpers — the local publish path is gone', () => {
  const src = fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'lib', 'draft.js'), 'utf8');
  expect(src, 'approveDraft/defaultSimMeta must be deleted (no fake entries)')
    .not.toMatch(/approveDraft|defaultSimMeta|defaultZonePoly/);
  expect(src, 'slugTitle must survive (entry ids)').toMatch(/export function slugTitle/);
  expect(src, 'entryIdFor must survive (the POST body carries this id)')
    .toMatch(/export function entryIdFor/);
});
