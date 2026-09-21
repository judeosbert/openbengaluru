/* Capture endpoint tests — REAL HTTP + REAL Postgres (${PGDATABASE}_test via
 * test/helpers/pgTest.js), the opts.db / opts.bucket / opts.verifyToken
 * seams (fakeVerifyToken twin; a recording bucket seam with putCaptureObject
 * — tests NEVER touch the real bucket backend).
 *
 * Locks POST /api/captures (plan: capture-leaderboard page):
 * - auth FIRST: missing/invalid bearer -> 401 before any body or param work.
 * - 400: bad method enum, missing/blank junction, junction > 200 chars,
 *   non video/*|image/* content type, non-finite lat/lng, unparseable
 *   capturedAt, client hash != recomputed SHA-256.
 * - 413: body over the route cap (opts.captureMaxBytes seam in tests; 100 MB
 *   in prod) — the route owns its raw-body cap, not the global JSON guard.
 * - 409: same author re-sends the same bytes ('already uploaded'); the dup
 *   check runs BEFORE the bucket put — a duplicate never creates an object.
 * - 500: bucket put failure ('capture storage failed: …', no DB row) and
 *   DB persist failure ('capture persist failed: …') — the orphan risk is
 *   accepted and documented (bucket object may outlive a failed row write).
 * - 201 { id, points }: slug id, points = author total AFTER the insert;
 *   object at captures/<id>/<id>_<junction-slug>.<ext> with the posted
 *   bytes + content type; DB row carries junction/method/captured_at/
 *   content_hash/object_key/file_name/content_type/byte_size and RAW
 *   geo_lat/geo_lng (null when not granted).
 * - GET /api/captures/leaderboard is PUBLIC: { entries: [{ rank, name,
 *   points }] }, points DESC; 405 for wrong methods on both routes.
 *
 * Admin moderation (plan: capture-admin-moderation), all admin-gated
 * (401 anon / 403 non-admin, sims review-gate pattern):
 * - GET  /api/admin/captures          { captures: [...] } newest-first feed
 * - GET  /api/admin/captures/:id/file 400 bad id / 404 unknown / 200 bytes
 *                                      + stored content-type
 * - POST /api/admin/captures/:id/reject { reason } — 400 blank/oversize /
 *   404 unknown / 200 { ok, id } with the bucket object + DB row deleted
 *   (bucket first, retryable on storage failure; orphaned object accepted
 *   on a later DB failure) + fire-and-forget email carrying the reason
 *   (skipped, one log line, when author_email IS NULL); 405 wrong methods.
 */
import { it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSimServer } from '../server.js';
import * as dbStore from '../db.js';
import * as bucketStore from '../bucket.js';
import { slugTitle } from '../src/lib/draft.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';
import { ensureTestDb, testPool, requirePgEnv } from './helpers/pgTest.js';

requirePgEnv();

const ADMIN_EMAILS = ['admin@x.test'];

function fakeVerifyToken(token) {
  const users = {
    'tok-qa': { uid: 'qa', name: 'qa user', email: 'qa@x.test' },
    'tok-other': { uid: 'other', name: 'other user', email: 'other@x.test' },
    'tok-admin': { uid: 'admin', name: 'admin user',
      email: 'admin@x.test' },
  };
  if (users[token]) return users[token];
  throw new Error('bad token');
}

/* Real db.js API bound to the shared test-db pool, with the captures ops
 * (mirror of the server's makeDbApi). over.putCapture lets a case fail the
 * persist step; the moderation ops (plan: capture-admin-moderation) carry
 * the same over-ride style (over.deleteCapture fails the reject persist). */
function dbApi(over = {}) {
  return {
    putUploadRefs: (id, body, refs) =>
      dbStore.putUploadRefs(pool, id, body, refs),
    getSubmission: (id) => dbStore.getSubmission(pool, id),
    putCapture: over.putCapture
      ? over.putCapture : ((c) => dbStore.putCapture(pool, c)),
    findCaptureHash: (uid, h) => dbStore.findCaptureHash(pool, uid, h),
    listLeaderboard: (o) => dbStore.listLeaderboard(pool, o),
    listCaptures: over.listCaptures
      ? over.listCaptures : ((o) => dbStore.listCaptures(pool, o)),
    getCapture: over.getCapture
      ? over.getCapture : ((id) => dbStore.getCapture(pool, id)),
    deleteCapture: over.deleteCapture
      ? over.deleteCapture : ((id) => dbStore.deleteCapture(pool, id)),
  };
}

/* Recording bucket seam: putCaptureObject + the admin moderation ops
 * (getObjectBytes serves the stored bytes; deleteCaptureObjects removes
 * captures/<id>/ keys and records the batch). failPut / failDelete flip
 * the storage-failure cases. */
function fakeBucketApi() {
  const api = {
    objects: new Map(),
    puts: [],
    deletes: [],
    failPut: false,
    failDelete: false,
    async putCaptureObject(id, { name, contentType, bytes }) {
      if (api.failPut) throw new Error('bucket unreachable');
      const key = bucketStore.captureKey(id, name);
      const body = Buffer.from(bytes);
      api.objects.set(key, body);
      api.puts.push({ id, name, contentType, bytes: body, key });
      return {
        name, object_key: key, object_url: 's3://fake-bucket/' + key,
        size_bytes: body.length,
      };
    },
    async getObjectBytes(key) {
      const body = api.objects.get(key);
      if (!body) {
        const e = new Error('NoSuchKey');
        e.name = 'NoSuchKey';
        throw e;
      }
      return body;
    },
    async deleteCaptureObjects(id) {
      if (api.failDelete) throw new Error('bucket unreachable');
      const prefix = 'captures/' + id + '/';
      const keys = [...api.objects.keys()].filter((k) => k.startsWith(prefix));
      for (const k of keys) api.objects.delete(k);
      api.deletes.push({ id, keys });
      return keys.length;
    },
  };
  return api;
}

const created = [];
let pool;

function startServer(opts = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-cap-'));
  const distDir = path.join(td, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'),
    '<!DOCTYPE html><html><body>simo capture test</body></html>');
  const server = createSimServer({
    playerDir: td,
    distDir,
    rootDir: PLAYER_ROOT,
    db: opts.db || dbApi(),
    bucket: opts.bucket || fakeBucketApi(),
    verifyToken: fakeVerifyToken,
    adminEmails: ADMIN_EMAILS,
    mailer: { send: () => Promise.resolve() },
    sumoResolver: () => null,
    ...opts,
  });
  created.push({ server, td });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: 'http://127.0.0.1:' + port });
    });
  });
}

beforeAll(async () => {
  await ensureTestDb();
  pool = testPool();
});

beforeEach(async () => {
  await pool.query('truncate captures');
});

afterAll(async () => {
  for (const { server, td } of created) {
    server.close();
    fs.rmSync(td, { recursive: true, force: true });
  }
  if (pool) await pool.end();
});

/* --------------------------------------------------------------- helpers --- */

function auth(token) {
  return { Authorization: 'Bearer ' + token };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const CLIP = Buffer.from('fake-mp4-clip-bytes');

function postCapture(base, { bytes = CLIP, params = {}, token = 'tok-qa',
  contentType = 'video/mp4' } = {}) {
  const q = new URLSearchParams(params).toString();
  return fetch(base + '/api/captures' + (q ? '?' + q : ''), {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...(token ? auth(token) : {}) },
    body: bytes,
  });
}

const CAPTURE_ROW = (id) =>
  pool.query('select * from captures where id = $1', [id]);

const rowCount = () =>
  pool.query('select count(*)::int as n from captures').then((r) => r.rows[0].n);

/* ------------------------------------------------------------------ auth --- */

it('missing token -> 401 before any param or body validation', async () => {
  const { base } = await startServer();
  const res = await postCapture(base, { token: null });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('authentication failed');
});

it('invalid token -> 401', async () => {
  const { base } = await startServer();
  const res = await postCapture(base, { token: 'not-the-token' });
  expect(res.status).toBe(401);
});

/* ------------------------------------------------------------ validation --- */

it.each([
  ['unknown method enum', { method: 'vibes' }],
  ['missing junction', { junction: '' }],
  ['blank junction', { junction: '   ' }],
  ['junction over 200 chars', { junction: 'x'.repeat(201) }],
  ['non-finite lat', { lat: 'abc' }],
  ['non-finite lng', { lng: 'nan' }],
  ['unparseable capturedAt', { capturedAt: 'not-a-date' }],
])('bad metadata -> 400 (%s)', async (label, params) => {
  const { base } = await startServer();
  const res = await postCapture(base, { params });
  expect(res.status, label).toBe(400);
  expect((await res.json()).error, label).toBeTruthy();
});

it('content type must be video/* or image/*', async () => {
  const { base } = await startServer();
  const res = await postCapture(base,
    { contentType: 'text/plain', params: { junction: 'A', method: 'other' } });
  expect(res.status).toBe(400);
});

it('a client hash that disagrees with the recomputed SHA-256 -> 400', async () => {
  const { base } = await startServer();
  const res = await postCapture(base, {
    params: { junction: 'A', method: 'snapshot', hash: 'deadbeef' },
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/hash/i);
});

/* ------------------------------------------------------------------- 413 --- */

it('body over the route cap -> 413 (opts.captureMaxBytes seam)', async () => {
  const { base } = await startServer({ captureMaxBytes: 16 });
  const res = await postCapture(base, {
    bytes: Buffer.alloc(64), params: { junction: 'A', method: 'snapshot' },
  });
  expect(res.status).toBe(413);
});

/* -------------------------------------------------------------- happy path --- */

it('POST /api/captures -> 201 { id, points: 1 } with the object + row stored',
  async () => {
    const bucketApi = fakeBucketApi();
    const { base } = await startServer({ bucket: bucketApi });
    const res = await postCapture(base, {
      params: { junction: 'Silk Board Junction!', method: 'snapshot',
        capturedAt: '2026-01-02T03:04:05.000Z' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe('string');
    expect(body.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(body.points).toBe(1);

    /* the object: captures/<id>/<id>_<junction-slug>.<ext>, exact bytes +
     * content type, recorded exactly once */
    expect(bucketApi.puts.length).toBe(1);
    const put = bucketApi.puts[0];
    expect(put.id).toBe(body.id);
    expect(put.name).toBe(body.id + '_' + slugTitle('Silk Board Junction!')
      + '.mp4');
    expect(put.contentType).toBe('video/mp4');
    expect(put.bytes.equals(CLIP)).toBe(true);
    expect(put.key).toBe('captures/' + body.id + '/' + put.name);
    expect(bucketApi.objects.get(put.key).equals(CLIP)).toBe(true);

    /* the row: full attribution + metadata, geo untouched */
    const r = (await CAPTURE_ROW(body.id)).rows[0];
    expect(r.author_uid).toBe('qa');
    expect(r.author_name).toBe('qa user');
    expect(r.author_email).toBe('qa@x.test');
    expect(r.junction).toBe('Silk Board Junction!');
    expect(r.method).toBe('snapshot');
    expect(r.captured_at.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(r.content_hash).toBe(sha256(CLIP));
    expect(r.object_key).toBe(put.key);
    expect(r.file_name).toBe(put.name);
    expect(r.content_type).toBe('video/mp4');
    expect(Number(r.byte_size)).toBe(CLIP.length);
    expect(r.geo_lat).toBeNull();
    expect(r.geo_lng).toBeNull();
  });

it('a matching client hash short-circuits cleanly -> 201', async () => {
  const { base } = await startServer();
  const res = await postCapture(base, {
    params: { junction: 'A', method: 'other', hash: sha256(CLIP) },
  });
  expect(res.status).toBe(201);
});

it('granted geo rides along RAW (query lat/lng stored verbatim)', async () => {
  const { base } = await startServer();
  const res = await postCapture(base, {
    params: { junction: 'A', method: 'snapshot', lat: '12.97123',
      lng: '77.723' },
  });
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const r = (await CAPTURE_ROW(id)).rows[0];
  expect(r.geo_lat).toBeCloseTo(12.97123);
  expect(r.geo_lng).toBeCloseTo(77.723);
});

it('a second capture by the same author increments their points', async () => {
  const { base } = await startServer();
  const r1 = await postCapture(base, { params: { junction: 'A',
    method: 'snapshot' } });
  expect((await r1.json()).points).toBe(1);
  const r2 = await postCapture(base, {
    bytes: Buffer.from('different-clip'),
    params: { junction: 'B', method: 'footbridge' } });
  expect((await r2.json()).points).toBe(2);
});

/* --------------------------------------------------------------- duplicate --- */

it('same author + same bytes -> 409 "already uploaded" and NO second object',
  async () => {
    const bucketApi = fakeBucketApi();
    const { base } = await startServer({ bucket: bucketApi });
    const first = await postCapture(base, {
      params: { junction: 'A', method: 'snapshot' } });
    expect(first.status).toBe(201);
    const dupe = await postCapture(base, {
      params: { junction: 'A', method: 'snapshot' } });
    expect(dupe.status).toBe(409);
    expect((await dupe.json()).error).toMatch(/already uploaded/i);
    /* the dup check runs BEFORE the bucket put — one object, one row */
    expect(bucketApi.puts.length).toBe(1);
    expect(await rowCount()).toBe(1);
  });

/* --------------------------------------------------------------- failures --- */

it('bucket put failure -> 500, no DB row; a retry succeeds', async () => {
  const bucketApi = fakeBucketApi();
  const { base } = await startServer({ bucket: bucketApi });
  bucketApi.failPut = true;
  const res = await postCapture(base, {
    params: { junction: 'A', method: 'snapshot' } });
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/capture storage failed/);
  expect(await rowCount()).toBe(0);
  bucketApi.failPut = false;
  const retry = await postCapture(base, {
    params: { junction: 'A', method: 'snapshot' } });
  expect(retry.status).toBe(201);
});

it('db persist failure -> 500 (the bucket object may orphan; accepted)',
  async () => {
    const { base } = await startServer({
      db: dbApi({ putCapture: async () => {
        throw new Error('db down');
      } }),
    });
    const res = await postCapture(base, {
      params: { junction: 'A', method: 'snapshot' } });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/capture persist failed/);
  });

/* ------------------------------------------------------------- leaderboard --- */

it('GET /api/captures/leaderboard is public with ranked entries', async () => {
  const { base } = await startServer();
  await postCapture(base, { params: { junction: 'A', method: 'snapshot' } });
  await postCapture(base, { bytes: Buffer.from('clip-2'),
    params: { junction: 'B', method: 'snapshot' } });
  await postCapture(base, {
    token: 'tok-other', bytes: Buffer.from('clip-3'),
    params: { junction: 'C', method: 'stopwatch' } });
  /* anonymous — no Authorization header at all */
  const res = await fetch(base + '/api/captures/leaderboard');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ entries: [
    { rank: 1, name: 'qa user', points: 2 },
    { rank: 2, name: 'other user', points: 1 },
  ] });
});

it('the leaderboard is empty before any captures', async () => {
  const { base } = await startServer();
  const res = await fetch(base + '/api/captures/leaderboard');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ entries: [] });
});

/* ------------------------------------------------------------- method 405 --- */

it('wrong methods -> 405 on both routes', async () => {
  const { base } = await startServer();
  expect((await fetch(base + '/api/captures')).status).toBe(405);
  expect((await fetch(base + '/api/captures/leaderboard', {
    method: 'POST' })).status).toBe(405);
});

/* --------------------------------------------- admin moderation (plan: capture-admin-moderation) --- */
/* Three admin-gated routes over the captures table: the list feed, the
 * file proxy (bearer-gated — a bare <a href> can never work), and reject
 * (HARD delete: bucket object + DB row, leaderboard point self-heals,
 * fire-and-forget email carrying the reason). Auth gate mirrors the sims
 * review routes: 401 anon / 403 non-admin. */

/* Seed one capture row + object directly through the injected seams (the
 * upload route always carries an email claim; seeding controls
 * author_email and ordering). */
async function seedCapture(bucketApi, db, { id, uid = 'qa',
  name = 'qa user', email = 'qa@x.test', junction = 'A Junction',
  method = 'snapshot', capturedAt = null } = {}) {
  const bytes = Buffer.from('clip-' + id);
  const ref = await bucketApi.putCaptureObject(id, {
    name: id + '_a-junction.mp4', contentType: 'video/mp4', bytes,
  });
  await db.putCapture({
    id, authorUid: uid, authorName: name, authorEmail: email,
    junction, method,
    capturedAt: capturedAt ? new Date(capturedAt) : null,
    contentHash: 'hash-' + id, objectKey: ref.object_key,
    fileName: ref.name, contentType: 'video/mp4',
    byteSize: bytes.length, geoLat: null, geoLng: null,
  });
  return { id, objectKey: ref.object_key, bytes };
}

function fakeMailer() {
  const mailer = { mails: [], send(m) {
    mailer.mails.push(m);
    return Promise.resolve();
  } };
  return mailer;
}

function adminPost(base, id, body, token = 'tok-admin') {
  return fetch(base + '/api/admin/captures/' + id + '/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(token ? auth(token) : {}) },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------- gate --- */

it('GET /api/admin/captures -> 401 anon / 403 non-admin', async () => {
  const { base } = await startServer();
  const anon = await fetch(base + '/api/admin/captures');
  expect(anon.status).toBe(401);
  expect((await anon.json()).error).toBe('authentication failed');
  const user = await fetch(base + '/api/admin/captures',
    { headers: auth('tok-qa') });
  expect(user.status).toBe(403);
  expect((await user.json()).error).toBe('admin only');
});

/* -------------------------------------------------------------------- list --- */

it('GET /api/admin/captures -> 200 admin: newest-first feed with the row '
  + 'shape', async () => {
  const bucketApi = fakeBucketApi();
  const { base } = await startServer({ bucket: bucketApi });
  await seedCapture(bucketApi, dbApi(), { id: 'cap-feed-a' });
  await new Promise((r) => setTimeout(r, 20));
  await seedCapture(bucketApi, dbApi(), { id: 'cap-feed-b',
    junction: 'B Junction', method: 'footbridge' });
  const res = await fetch(base + '/api/admin/captures',
    { headers: auth('tok-admin') });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.captures)).toBe(true);
  expect(body.captures.map((c) => c.id))
    .toEqual(['cap-feed-b', 'cap-feed-a']);
  for (const c of body.captures) {
    expect(typeof c.byte_size, 'byte_size normalized to a number')
      .toBe('number');
    expect(c.junction).toBeTruthy();
    expect(c.author_name).toBe('qa user');
    expect(c.author_email).toBe('qa@x.test');
    expect(c.content_type).toBe('video/mp4');
  }
  expect(body.captures[0].method).toBe('footbridge');
});

/* -------------------------------------------------------------------- file --- */

it('GET /api/admin/captures/:id/file -> 401 anon / 403 non-admin', async () => {
  const bucketApi = fakeBucketApi();
  const { base } = await startServer({ bucket: bucketApi });
  await seedCapture(bucketApi, dbApi(), { id: 'cap-file-1' });
  const anon = await fetch(base + '/api/admin/captures/cap-file-1/file');
  expect(anon.status).toBe(401);
  const user = await fetch(base + '/api/admin/captures/cap-file-1/file',
    { headers: auth('tok-qa') });
  expect(user.status).toBe(403);
});

it('GET /api/admin/captures/:id/file -> 400 invalid id / 404 unknown id',
  async () => {
    const bucketApi = fakeBucketApi();
    const { base } = await startServer({ bucket: bucketApi });
    await seedCapture(bucketApi, dbApi(), { id: 'cap-file-2' });
    expect((await fetch(base
      + '/api/admin/captures/CAP-UPPER/file',
    { headers: auth('tok-admin') })).status)
      .toBe(400);
    expect((await fetch(base
      + '/api/admin/captures/cap-missing/file',
    { headers: auth('tok-admin') })).status)
      .toBe(404);
  });

it('GET /api/admin/captures/:id/file -> 200 bytes with the stored '
  + 'content type', async () => {
  const bucketApi = fakeBucketApi();
  const { base } = await startServer({ bucket: bucketApi });
  const seeded = await seedCapture(bucketApi, dbApi(), { id: 'cap-file-3' });
  const res = await fetch(base + '/api/admin/captures/cap-file-3/file',
    { headers: auth('tok-admin') });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('video/mp4');
  expect(Buffer.from(await res.arrayBuffer()).equals(seeded.bytes)).toBe(true);
});

/* ------------------------------------------------------------------ reject --- */

it('POST /api/admin/captures/:id/reject -> 401 anon / 403 non-admin',
  async () => {
    const bucketApi = fakeBucketApi();
    const { base } = await startServer({ bucket: bucketApi });
    await seedCapture(bucketApi, dbApi(), { id: 'cap-rej-g1' });
    const anon = await adminPost(base, 'cap-rej-g1', { reason: 'x' }, null);
    expect(anon.status).toBe(401);
    expect((await anon.json()).error).toBe('authentication failed');
    const user = await adminPost(base, 'cap-rej-g1', { reason: 'x' },
      'tok-qa');
    expect(user.status).toBe(403);
    expect((await user.json()).error).toBe('admin only');
  });

it('reject reason must be a trimmed non-empty string <= 4 KB -> 400',
  async () => {
    const bucketApi = fakeBucketApi();
    const { base } = await startServer({ bucket: bucketApi });
    await seedCapture(bucketApi, dbApi(), { id: 'cap-rej-v1' });
    for (const body of [{}, { reason: '' }, { reason: '   ' },
      { reason: 42 }, { reason: 'x'.repeat(4097) }]) {
      const res = await adminPost(base, 'cap-rej-v1', body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    /* the row survives every 400 */
    expect((await CAPTURE_ROW('cap-rej-v1')).rowCount).toBe(1);
  });

it('reject an unknown id -> 404', async () => {
  const { base } = await startServer();
  const res = await adminPost(base, 'cap-never', { reason: 'x' });
  expect(res.status).toBe(404);
});

it('reject -> 200 { ok, id }: row gone, bucket object deleted, leaderboard '
  + 'point dropped, email carries the reason verbatim', async () => {
  const bucketApi = fakeBucketApi();
  const mails = fakeMailer();
  const { base } = await startServer({ bucket: bucketApi, mailer: mails });
  await seedCapture(bucketApi, dbApi(), { id: 'cap-rej-1',
    junction: 'Gate Six' });
  await seedCapture(bucketApi, dbApi(), { id: 'cap-rej-2' });
  await seedCapture(bucketApi, dbApi(), { id: 'cap-rej-3', uid: 'other',
    name: 'other user', email: 'other@x.test' });

  const res = await adminPost(base, 'cap-rej-1', { reason: 'not a junction' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, id: 'cap-rej-1' });

  /* hard delete: the row AND its object are gone, siblings intact */
  expect((await CAPTURE_ROW('cap-rej-1')).rowCount).toBe(0);
  expect(bucketApi.deletes.length).toBe(1);
  expect(bucketApi.deletes[0].keys).toContain(
    'captures/cap-rej-1/cap-rej-1_a-junction.mp4');
  expect([...bucketApi.objects.keys()].filter((k) =>
    k.startsWith('captures/cap-rej-1/'))).toEqual([]);

  /* count(*) leaderboard self-heals: qa 2 -> 1, other 1 (qa ranks first —
   * their remaining capture is older) */
  const lb = await fetch(base + '/api/captures/leaderboard');
  expect(await lb.json()).toEqual({ entries: [
    { rank: 1, name: 'qa user', points: 1 },
    { rank: 2, name: 'other user', points: 1 },
  ] });

  /* fire-and-forget email to the uploader carrying the admin reason */
  expect(mails.mails.length).toBe(1);
  expect(mails.mails[0].to).toEqual(['qa@x.test']);
  expect(mails.mails[0].subject)
    .toBe('[OpenBengaluru] Your capture at "Gate Six" was removed');
  expect(mails.mails[0].text).toContain('not a junction');
});

it('reject with author_email NULL -> 200, no email sent', async () => {
  const bucketApi = fakeBucketApi();
  const mails = fakeMailer();
  const { base } = await startServer({ bucket: bucketApi, mailer: mails });
  await seedCapture(bucketApi, dbApi(), { id: 'cap-rej-n1', email: null });
  const res = await adminPost(base, 'cap-rej-n1', { reason: 'blurry' });
  expect(res.status).toBe(200);
  expect(mails.mails).toEqual([]);
  expect((await CAPTURE_ROW('cap-rej-n1')).rowCount).toBe(0);
});

it('reject: bucket failure -> 500 "capture storage failed", row intact '
  + '(retryable)', async () => {
  const bucketApi = fakeBucketApi();
  const { base } = await startServer({ bucket: bucketApi });
  await seedCapture(bucketApi, dbApi(), { id: 'cap-rej-b1' });
  bucketApi.failDelete = true;
  const res = await adminPost(base, 'cap-rej-b1', { reason: 'x' });
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/capture storage failed/);
  /* row intact + object intact — the admin retries */
  expect((await CAPTURE_ROW('cap-rej-b1')).rowCount).toBe(1);
  expect(bucketApi.deletes).toEqual([]);
  bucketApi.failDelete = false;
  const retry = await adminPost(base, 'cap-rej-b1', { reason: 'x' });
  expect(retry.status).toBe(200);
});

it('reject: db persist failure -> 500 "capture persist failed" AFTER the '
  + 'bucket delete (orphan accepted)', async () => {
  const bucketApi = fakeBucketApi();
  const { base } = await startServer({
    bucket: bucketApi,
    db: dbApi({ deleteCapture: async () => {
      throw new Error('db down');
    } }),
  });
  await seedCapture(bucketApi, dbApi({ deleteCapture: async () => {
    throw new Error('db down');
  } }), { id: 'cap-rej-d1' });
  const res = await adminPost(base, 'cap-rej-d1', { reason: 'x' });
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/capture persist failed/);
  /* the bucket delete ran FIRST (matching the upload's ordering) — the
   * orphaned object is accepted, the row stays until the retry */
  expect(bucketApi.deletes.length).toBe(1);
  expect((await CAPTURE_ROW('cap-rej-d1')).rowCount).toBe(1);
});

/* ------------------------------------------------- admin routes method 405 --- */

it('wrong methods -> 405 on the admin capture routes', async () => {
  const bucketApi = fakeBucketApi();
  const { base } = await startServer({ bucket: bucketApi });
  await seedCapture(bucketApi, dbApi(), { id: 'cap-405-1' });
  expect((await fetch(base + '/api/admin/captures', {
    method: 'POST' })).status).toBe(405);
  expect((await fetch(base + '/api/admin/captures/cap-405-1/file', {
    method: 'POST', headers: auth('tok-admin') })).status).toBe(405);
  expect((await fetch(base + '/api/admin/captures/cap-405-1/reject',
    { headers: auth('tok-admin') })).status).toBe(405);
});