/* db.js unit tests — REAL Postgres against the test database
 * ${PGDATABASE}_test, schema applied from db/schema.sql (idempotent, so the
 * suite self-provisions; `npm run db:setup` is the documented dev path).
 * Locks the upload-reference API the server's /api/files routes are built
 * on: put -> list/get round-trip, sims metadata mapping (desc ->
 * description, anchor -> lat/lng), replace-on-re-put semantics in ONE
 * transaction (a failing ref rolls the whole put back), FK guard + cascade,
 * and the slug-injection probe staying a single literal parameter.
 *
 * Needs all five PG* vars (no defaults, mirroring db.js's fail-fast
 * contract): PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE.
 */
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { putUploadRefs, listUploads, getUploadRef } from '../db.js';
import { ensureTestDb, testPool, requirePgEnv } from './helpers/pgTest.js';

/* Fail fast listing missing PG* vars (no defaults, mirroring db.js). */
requirePgEnv();

const POOLS = [];
let pool;

beforeAll(async () => {
  await ensureTestDb();
  const pool0 = testPool();
  POOLS.push(pool0);
  pool = pool0;
});

beforeEach(async () => {
  await pool.query('truncate sims cascade');
});

afterAll(async () => {
  for (const p of POOLS) await p.end();
});

function body(over = {}) {
  return {
    title: 'DB upload test',
    author: 'qa',
    desc: 'db round-trip',
    anchor: [12.97, 77.72],
    rotation: 7,
    ...over,
  };
}

/* Refs are opaque to db.js — it stores them verbatim; the key/url values
 * here are neutral literals, not bucket-format assertions. */
function refs(id, names = ['today.net.xml', 'demand.rou.xml']) {
  return names.map((name) => ({
    name,
    object_key: 'k/' + id + '/' + name,
    object_url: 'u/' + id + '/' + name,
    size_bytes: 11,
  }));
}

/* ------------------------------------------------------------ roundtrip --- */

it('put then list/get round-trips the refs (exact shape, int8 as number)', async () => {
  const id = 'dbup-rt';
  const names = await putUploadRefs(pool, id, body(), refs(id));
  expect(names).toEqual(['demand.rou.xml', 'today.net.xml']);
  expect(await listUploads(pool, id))
    .toEqual(['demand.rou.xml', 'today.net.xml']);
  expect(await getUploadRef(pool, id, 'today.net.xml')).toEqual({
    name: 'today.net.xml',
    object_key: 'k/' + id + '/today.net.xml',
    object_url: 'u/' + id + '/today.net.xml',
    size_bytes: 11,
  });
});

it('listUploads -> [] and getUploadRef -> null for unknown ids/names', async () => {
  expect(await listUploads(pool, 'dbup-unknown')).toEqual([]);
  expect(await getUploadRef(pool, 'dbup-unknown', 'today.net.xml'))
    .toBeNull();
  await putUploadRefs(pool, 'dbup-known', body(), refs('dbup-known'));
  expect(await getUploadRef(pool, 'dbup-known', 'nope.xml')).toBeNull();
});

/* -------------------------------------------------------------- metadata --- */

it('sim metadata maps body -> sims columns (desc, anchor, rotation)', async () => {
  await putUploadRefs(pool, 'dbup-meta', body(), refs('dbup-meta'));
  const row = (await pool.query('select * from sims where id = $1',
    ['dbup-meta'])).rows[0];
  expect(row.title).toBe('DB upload test');
  expect(row.author).toBe('qa');
  expect(row.description).toBe('db round-trip');
  expect(row.anchor_lat).toBeCloseTo(12.97);
  expect(row.anchor_lng).toBeCloseTo(77.72);
  expect(row.rotation).toBeCloseTo(7);
});

it('a minimal body stores nulls for the optional columns', async () => {
  await putUploadRefs(pool, 'dbup-min', { title: 'min' }, refs('dbup-min'));
  const row = (await pool.query('select * from sims where id = $1',
    ['dbup-min'])).rows[0];
  expect(row.title).toBe('min');
  expect(row.author).toBeNull();
  expect(row.description).toBeNull();
  expect(row.anchor_lat).toBeNull();
  expect(row.anchor_lng).toBeNull();
  expect(row.rotation).toBeNull();
});

/* -------------------------------------------------------------- replace --- */

it('re-put replaces the sim row and the refs (no stale proposed.net.xml)', async () => {
  const id = 'dbup-idem';
  await putUploadRefs(pool, id, body(),
    refs(id, ['today.net.xml', 'demand.rou.xml', 'proposed.net.xml']));
  expect((await listUploads(pool, id)).length).toBe(3);
  await putUploadRefs(pool, id, { title: 'Replaced' }, refs(id));
  expect(await listUploads(pool, id))
    .toEqual(['demand.rou.xml', 'today.net.xml']);
  expect(await getUploadRef(pool, id, 'proposed.net.xml')).toBeNull();
  const row = (await pool.query('select * from sims where id = $1',
    [id])).rows[0];
  expect(row.title).toBe('Replaced');
  expect(row.author).toBeNull();          // full replace, not merge
  expect(row.updated_at >= row.created_at).toBe(true);
});

it('a failing ref name rolls the whole put back (single transaction)', async () => {
  const id = 'dbup-atomic';
  await putUploadRefs(pool, id, body(), refs(id));
  await expect(putUploadRefs(pool, id, { title: 'v2' }, [
    ...refs(id, ['today.net.xml']),
    { name: 'evil.xml', object_key: 'k', object_url: 'u', size_bytes: 1 },
  ])).rejects.toThrow();
  expect(await listUploads(pool, id))
    .toEqual(['demand.rou.xml', 'today.net.xml']);
  const row = (await pool.query('select title from sims where id = $1',
    [id])).rows[0];
  expect(row.title).toBe('DB upload test');   // the sims upsert rolled back too
});

/* --------------------------------------------------------- FK + cascade --- */

it('sim_files without a parent sim is rejected (FK); deleting the sim cascades', async () => {
  await expect(pool.query(
    'insert into sim_files (sim_id, name, object_key, object_url, size_bytes)'
    + " values ('dbup-orphan', 'today.net.xml', 'k', 'u', 1)",
  )).rejects.toThrow(/foreign key/i);
  await putUploadRefs(pool, 'dbup-casc', body(), refs('dbup-casc'));
  expect((await listUploads(pool, 'dbup-casc')).length).toBe(2);
  await pool.query('delete from sims where id = $1', ['dbup-casc']);
  expect(await listUploads(pool, 'dbup-casc')).toEqual([]);
});

/* ---------------------------------------------------- injection defense --- */

it('hostile id stays a literal parameter (no interpolation, no damage)', async () => {
  const evil = "x'; drop table sims;--";
  expect(await listUploads(pool, evil)).toEqual([]);
  expect(await getUploadRef(pool, evil, 'today.net.xml')).toBeNull();
  await expect(putUploadRefs(pool, evil, body(), refs('x')))
    .rejects.toThrow(/check constraint/);
  const n = (await pool.query(
    'select count(*)::int as n from sims')).rows[0].n;
  expect(n).toBe(0);   // table intact and empty — the probe changed nothing
});