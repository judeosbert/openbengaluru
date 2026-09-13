/* tools/migrate_file_entries.js — the optional legacy-ride-along migration
 * (plan rollout step 3). Locks the pure split: collectLegacy (entry has a
 * sims row -> migratable; no row -> dev scratch) and parseStreamFile (the
 * one-line JSONP contract), plus migrateOne's write shape against fake
 * pool/bucket seams (entry_json + sim_ready=true, payload NOT the JSONP
 * wrapper). No real Postgres/bucket needed. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectLegacy, parseStreamFile, migrateOne } from '../tools/migrate_file_entries.js';

const CATALOG = [
  { id: 'gen-1', title: 'Generated' },          // generated: no sims row
  { id: 'fff-mtza6f9y', title: 'Legacy FFF' },  // legacy ride-along: row
  { id: 'dev-scratch', title: 'Scratch' },      // CLI injection: no row
];

it('collectLegacy splits by sims-row membership', () => {
  const rows = new Set(['fff-mtza6f9y']);
  const { migrate, scratch } = collectLegacy(CATALOG, rows);
  expect(migrate.map((e) => e.id)).toEqual(['fff-mtza6f9y']);
  expect(scratch).toEqual(['gen-1', 'dev-scratch']);
  // tolerant of arrays/sets and empties
  expect(collectLegacy(null, new Set()).migrate).toEqual([]);
  expect(collectLegacy([{ id: 'a' }], ['a']).migrate.map((e) => e.id))
    .toEqual(['a']);
});

it('parseStreamFile returns the payload object, not the wrapper', () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-migrate-'));
  const payload = { nFrames: 2, bounds: [0, 0, 1, 1],
    scenarios: { today: { frames: 'AAAA' } } };
  fs.writeFileSync(path.join(td, 'legacy-1.js'),
    "window.__simoStreamCallback('legacy-1'," + JSON.stringify(payload)
    + ');\n');
  expect(parseStreamFile(td, 'legacy-1')).toEqual(payload);
  fs.writeFileSync(path.join(td, 'bad.js'), 'not a stream\n');
  expect(() => parseStreamFile(td, 'bad')).toThrow(/payload/);
  expect(() => parseStreamFile(td, 'missing')).toThrow(/ENOENT|no such file/i);
});

it('migrateOne stores entry_json + sim_ready and the raw stream payload', async () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-migrate-'));
  const payload = { nFrames: 1, scenarios: { today: { frames: 'AA==' } } };
  fs.writeFileSync(path.join(td, 'leg-a.js'),
    "window.__simoStreamCallback('leg-a'," + JSON.stringify(payload) + ');\n');
  const writes = [];
  const pool = {
    async query(sql, params) {
      writes.push({ sql, params });
      if (sql.startsWith('update sims')) {
        return { rowCount: 1, rows: [{ status: 'active' }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  const sent = [];
  const bucket = {
    bucket: 'fake-bkt',
    send: async (cmd) => {
      writes.push({ cmd: cmd.constructor.name, input: cmd.input });
      return {};
    },
  };
  const r = await migrateOne(pool, bucket, 'leg-a',
    { id: 'leg-a', title: 'Legacy A' }, td);
  expect(r).toEqual({ id: 'leg-a', status: 'active', stream: true });
  const update = writes.find((w) => w.sql && w.sql.startsWith('update sims'));
  expect(update.params[0]).toBe('leg-a');
  expect(JSON.parse(update.params[1])).toEqual({ id: 'leg-a',
    title: 'Legacy A' });
  const put = writes.find((w) => w.cmd === 'PutObjectCommand');
  expect(put.input.Key).toBe('uploads/leg-a/review/stream.json');
  expect(JSON.parse(put.input.Body)).toEqual(payload);   // payload, no wrapper
});

/* describe import guard: vitest fine with bare it; keep describe exercised */
describe('migrate tool', () => {
  it('exports are wired', () => {
    expect(typeof collectLegacy).toBe('function');
    expect(typeof parseStreamFile).toBe('function');
    expect(typeof migrateOne).toBe('function');
  });
});