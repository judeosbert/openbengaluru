/* POST /api/simulate endpoint test — REAL HTTP, REAL SUMO, REAL Postgres
 * (the ${PGDATABASE}_test database via test/helpers/pgTest.js) and an
 * in-memory fake for the bucket seam (per plan: no MinIO docker default;
 * opt-in real run in test/bucket.test.js). Persistence contract (plan:
 * review flow + dashboards):
 *
 *   POST a fixture net+rou -> 200, sims row (pending + sim_ready +
 *   entry_json) in the test DB + review artifacts in the bucket seam, NO
 *   player-dir writes (data.js/streams untouched); garbage net -> 422;
 *   undiscoverable SUMO -> 500; oversize body -> 413; bad input -> 400;
 *   failing db/bucket backend -> 500 via the injected opts.db /
 *   opts.bucket seams; missing or invalid bearer token -> 401 via the
 *   injected opts.verifyToken seam (auth runs BEFORE body validation; the
 *   body author is ignored — the verified claims pick the author).
 *   Activation (admin) makes the entry visible on GET /api/catalog.
 *
 * Skips the SUMO-running cases when the binary is undiscoverable (the rest
 * of the suite still runs). The temp player dir is never mutated.
 */
import { it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSimServer } from '../server.js';
import { createPool, PoolBusyError } from '../pool.js';
import { findSumo } from '../tools/sumo_geom.js';
import * as dbStore from '../db.js';
import * as bucketStore from '../bucket.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';
import { ensureTestDb, testPool, requirePgEnv } from './helpers/pgTest.js';

const FIXDIR = path.join(PLAYER_ROOT, 'test', 'fixtures');
const ROU_XML = fs.readFileSync(path.join(FIXDIR, 'mini.rou.xml'), 'utf8');
const NET_XML = fs.readFileSync(path.join(FIXDIR, 'mini.net.xml'), 'utf8');
const SUMO = findSumo();

/* Fail fast listing missing PG* vars (no defaults, mirroring db.js). */
requirePgEnv();

let pool;

beforeAll(async () => {
  await ensureTestDb();
  pool = testPool();
});

/* the endpoint suite shares the test database — truncate per test so rows
 * from one case never leak into another's catalog/submissions assertions */
beforeEach(async () => {
  await pool.query('truncate sims cascade');
});

/* ------------------------------------------------------------- harness --- */

const created = [];

/* Real db.js API bound to the shared test-db pool (full makeDbApi mirror). */
function dbApi() {
  return {
    putUploadRefs: (id, body, refs) =>
      dbStore.putUploadRefs(pool, id, body, refs),
    listUploads: (id) => dbStore.listUploads(pool, id),
    getUploadRef: (id, name) => dbStore.getUploadRef(pool, id, name),
    getSubmission: (id) => dbStore.getSubmission(pool, id),
    listSubmissions: (f) => dbStore.listSubmissions(pool, f),
    listActiveEntries: () => dbStore.listActiveEntries(pool),
    listComments: (id) => dbStore.listComments(pool, id),
    addComment: (id, c) => dbStore.addComment(pool, id, c),
    setStatus: (id, s) => dbStore.setStatus(pool, id, s),
    activateTx: (id, o) => dbStore.activateTx(pool, id, o),
    finalizeSim: (id, o) => dbStore.finalizeSim(pool, id, o),
  };
}

/* In-memory bucket seam twin — putObjects returns the same ref shape as
 * bucket.js (real key building + guards), bytes stay in a Map; the review
 * artifact ops ride the real reviewKey guards. */
function fakeBucketApi() {
  const objects = new Map();
  return {
    objects,
    async putObjects(id, files) {
      return files.map(({ name, text }) => {
        const key = bucketStore.objectKey(id, name);
        objects.set(key, Buffer.from(text));
        return {
          name,
          object_key: key,
          object_url: 's3://fake-bucket/' + key,
          size_bytes: Buffer.byteLength(text),
        };
      });
    },
    async putReviewArtifacts(id, arts) {
      for (const kind of ['pack', 'stream']) {
        if (arts[kind] != null) {
          objects.set(bucketStore.reviewKey(id, kind),
            Buffer.from(JSON.stringify(arts[kind])));
        }
      }
    },
    async getReviewStream(id) {
      const v = objects.get(bucketStore.reviewKey(id, 'stream'));
      return v ? JSON.parse(v.toString('utf8')) : null;
    },
    async deleteObjects(id) {
      const prefix = 'uploads/' + id + '/';
      let n = 0;
      for (const k of [...objects.keys()]) {
        if (k.startsWith(prefix)) {
          objects.delete(k);
          n++;
        }
      }
      return n;
    },
    async getObjectBytes(key) {
      const v = objects.get(key);
      if (!v) {
        const e = new Error('The specified key does not exist.');
        e.name = 'NoSuchKey';
        throw e;
      }
      return v;
    },
  };
}

/* Auth seam twin (mirrors the db/bucket seam fakes): 'tok-qa' verifies as
 * the regular user, 'tok-admin' as the review admin (opts.adminEmails);
 * anything else throws — the server turns that into 401. */
function fakeVerifyToken(token) {
  if (token === 'tok-qa') {
    return { uid: 'qa', name: 'qa user', email: 'qa@x.test' };
  }
  if (token === 'tok-admin') {
    return { uid: 'admin-1', name: 'admin', email: 'admin@x.test' };
  }
  throw new Error('bad token');
}

function startServer(opts = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-endp-'));
  fs.mkdirSync(path.join(td, 'streams'));
  fs.writeFileSync(path.join(td, 'data.js'),
    'const OTHER_SIMS = [];\nconst CATALOG = [];\n');
  const distDir = path.join(td, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'),
    '<!DOCTYPE html><html><body>simo endpoint test</body></html>');
  const bucket = opts.bucket || fakeBucketApi();
  const server = createSimServer({
    playerDir: td,
    distDir,
    rootDir: PLAYER_ROOT,                   // simo-player/ — the real tools
    db: opts.db || dbApi(),                 // real refs on the TEST database
    bucket,                                 // bytes in memory, keys real
    verifyToken: fakeVerifyToken,
    adminEmails: ['admin@x.test'],
    mailer: { send: () => Promise.resolve() },   // no SMTP env in tests
    ...(opts.sumoResolver ? {} : { sumoResolver: () => SUMO }),
    ...opts,
  });
  created.push({ server, td });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, td, port, base: 'http://127.0.0.1:' + port,
        bucket });
    });
  });
}

afterAll(async () => {
  for (const { server, td } of created) {
    server.close();
    fs.rmSync(td, { recursive: true, force: true });
  }
  if (pool) await pool.end();
});

function postBody(over = {}) {
  return JSON.stringify({
    id: 'endp-' + Math.random().toString(36).slice(2, 8),
    title: 'Endpoint test run',
    author: 'qa',
    desc: 'posted from endpoint test',
    rouXml: ROU_XML,
    todayNetXml: NET_XML,
    anchor: [12.97, 77.72],
    rotation: 7,
    dataSource: 'survey_data',
    sourceUrl: 'https://example.test/counts',
    ...over,
  });
}

function post(base, data, extra = {}) {
  return fetch(base + '/api/simulate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-qa',
    },
    body: data,
    ...extra,
  });
}

/* Total vehicles across all packed frames (9-byte records per vehicle). */
function vehicleFrameCount(framesB64) {
  const raw = Buffer.from(framesB64, 'base64');
  let o = 0, total = 0;
  while (o + 2 <= raw.length) {
    const n = raw.readUInt16LE(o);
    o += 2 + 9 * n;
    total += n;
  }
  return total;
}

/* --------------------------------------------------------------- tests --- */

it.skipIf(!SUMO)('POST /api/simulate runs the real pipeline: 200 + DB row + bucket artifacts, no player-dir writes', async () => {
  const { base, td, bucket } = await startServer();
  const res = await post(base, postBody({ id: 'endp-happy' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: 'endp-happy' });

  /* DB row: pending review status + the full entry_json */
  const row = await dbStore.getSubmission(pool, 'endp-happy');
  expect(row.status).toBe('pending');
  expect(row.sim_ready).toBe(true);
  expect(row.author_uid).toBe('qa');
  expect(row.author).toBe('qa user');     // verified claims, not the body
  expect(row.description).toBe('posted from endpoint test');
  expect(row.demand).toBe(150);           // 120 + 30 veh/h from the fixture
  expect(row.entry_json.nFrames).toBe(900);
  /* the net carries projParameter="!" + sentinel origBoundary -> NON-geo
   * (geoLock guard): placement falls back to the posted wizard anchor,
   * never geo-locked from fake net bounds */
  expect(row.entry_json.anchor).toEqual([12.97, 77.72]);
  expect(row.entry_json.rotation).toBe(7);
  expect(row.entry_json.dataSource).toBe('survey_data');
  expect(row.entry_json.sourceUrl).toBe('https://example.test/counts');
  expect(row.entry_json.scenarios.today.geoLocked).toBeUndefined();
  expect(row.entry_json.scenarios.today.stats,
    'stats must ride inline in entry_json').toBeTruthy();

  /* bucket review artifacts: stream payload (NOT the JSONP wrapper) with
   * 900 real frames */
  const stream = await bucket.getReviewStream('endp-happy');
  expect(stream.nFrames).toBe(900);
  expect(Object.keys(stream.scenarios).sort()).toEqual(['today']);
  expect(typeof stream.scenarios.today.frames).toBe('string');
  expect(vehicleFrameCount(stream.scenarios.today.frames))
    .toBeGreaterThan(10);                  // 26 vehicles departed over 600 s

  /* NO player-dir mutation: data.js byte-identical, streams/ still empty */
  expect(fs.readFileSync(path.join(td, 'data.js'), 'utf8'))
    .toBe('const OTHER_SIMS = [];\nconst CATALOG = [];\n');
  expect(fs.readdirSync(path.join(td, 'streams'))).toEqual([]);

  /* NOT in the public catalog yet — activation is a separate admin step */
  const catalog = await fetch(base + '/api/catalog').then((r) => r.json());
  expect(catalog.map((e) => e.id)).toEqual([]);
});

it.skipIf(!SUMO)('activation serves the entry + stream on the public catalog API', async () => {
  const { base, bucket } = await startServer();
  expect((await post(base, postBody({ id: 'endp-catalog' }))).status)
    .toBe(200);
  let catalog = await fetch(base + '/api/catalog').then((r) => r.json());
  expect(catalog.map((e) => e.id)).toEqual([]);

  const res = await fetch(base + '/api/submissions/endp-catalog/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer tok-admin' },
    body: '{}',
  });
  expect(res.status).toBe(200);
  const served = await fetch(base + '/api/catalog').then((r) => r.json());
  expect(served.length).toBe(1);
  expect(served[0].id).toBe('endp-catalog');
  const streamRes = await fetch(base + '/api/catalog/endp-catalog/stream');
  expect(streamRes.status).toBe(200);
  expect(await streamRes.json()).toEqual(
    await bucket.getReviewStream('endp-catalog'));
});

it.skipIf(!SUMO)('a proposed net produces the A/B pair (entry_json scenarios)', async () => {
  const { base } = await startServer();
  const res = await post(base, postBody({
    id: 'endp-ab',
    proposedNetXml: NET_XML,
  }));
  expect(res.status).toBe(200);
  const row = await dbStore.getSubmission(pool, 'endp-ab');
  expect(Object.keys(row.entry_json.scenarios).sort())
    .toEqual(['proposed', 'today']);
  expect(row.has_proposed).toBe(true);
});

it.skipIf(!SUMO)('re-simulating the same id replaces (idempotent)', async () => {
  const { base } = await startServer();
  expect((await post(base, postBody({ id: 'endp-idem' }))).status).toBe(200);
  expect((await post(base, postBody({ id: 'endp-idem', title: 'Replaced' })))
    .status).toBe(200);
  const rows = await pool.query(
    'select id, title, entry_json from sims where id = $1', ['endp-idem']);
  expect(rows.rows.length).toBe(1);       // replace, never duplicate
  expect(rows.rows[0].title).toBe('Replaced');
  expect(rows.rows[0].entry_json.title).toBe('Replaced');
});

it.skipIf(!SUMO)('garbage net -> 422 with stderr tail', async () => {
  const { base } = await startServer();
  const res = await post(base, postBody({
    id: 'endp-bad',
    todayNetXml: '<not-a-net>this is garbage</not-a-net>',
  }));
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
});

it.skipIf(!SUMO)('failed simulate leaves a pending !sim_ready row and an empty catalog', async () => {
  const { base, td } = await startServer();
  const res = await post(base, postBody({
    id: 'endp-nopartial',
    todayNetXml: '<not-a-net>this is garbage</not-a-net>',
  }));
  expect(res.status).toBe(422);
  const row = await dbStore.getSubmission(pool, 'endp-nopartial');
  expect(row).toBeTruthy();
  expect(row.status).toBe('pending');
  expect(row.sim_ready).toBe(false);
  expect(row.entry_json).toBeNull();
  const catalog = await fetch(base + '/api/catalog').then((r) => r.json());
  expect(catalog).toEqual([]);
});

it('undiscoverable SUMO -> 500 with install hint', async () => {
  const { base } = await startServer({
    sumoResolver: () => null,
    // silence the SUMO-run cases: this server must fail before spawning
  });
  const res = await post(base, postBody({ id: 'endp-nosumo' }));
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body.error).toMatch(/sumo/i);
});

it('path-like ids are rejected with 400', async () => {
  const { base } = await startServer();
  const res = await post(base, postBody({ id: '../evil' }));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
});

it('missing rouXml is rejected with 400', async () => {
  const { base } = await startServer();
  const res = await post(base, postBody({ rouXml: undefined }));
  expect(res.status).toBe(400);
});

it('oversized body -> 413', async () => {
  const { base } = await startServer({ maxBodyBytes: 512 });
  const res = await post(base, postBody({
    id: 'endp-big',
    rouXml: 'x'.repeat(2048),
  }));
  expect(res.status).toBe(413);
});

/* -------------------------------------------------- auth gate (401) --- */
/* opts.verifyToken seam — twin of the db/bucket seams; the fake above
 * verifies 'tok-qa'/'tok-admin'. Auth happens BEFORE body
 * parsing/validation, so a 401 wins over every body-level outcome and
 * nothing is published. The body's author field is ignored: the verified
 * claims pick the author (authorFromProfile: displayName -> email prefix
 * -> uid). */

it('missing Authorization header -> 401, nothing published', async () => {
  const { base, bucket } = await startServer();
  const res = await post(base, postBody({ id: 'endp-noauth' }),
    { headers: { 'Content-Type': 'application/json' } });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('authentication failed');
  expect(await dbStore.getSubmission(pool, 'endp-noauth')).toBeNull();
  expect(bucket.objects.size).toBe(0);
});

it('invalid bearer token -> 401', async () => {
  const { base } = await startServer();
  const res = await post(base, postBody({ id: 'endp-badtok' }),
    { headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer not-the-qa-token' } });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('authentication failed');
});

it('401 wins over an invalid body (auth runs before validation)', async () => {
  const { base } = await startServer();
  const res = await post(base, '{not json', { headers: {} });
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('authentication failed');
});

it.skipIf(!SUMO)('the verified claims author overrides the body author', async () => {
  const { base } = await startServer();
  const res = await post(base, postBody({
    id: 'endp-authauthor',
    author: 'spoof',
  }));
  expect(res.status).toBe(200);
  const row = await dbStore.getSubmission(pool, 'endp-authauthor');
  expect(row.author).toBe('qa user');     // displayName from the token claims
  expect(row.author_uid).toBe('qa');
  expect(row.author_email).toBe('qa@x.test');
});

it('serves the player: / from dist, /data.js from the player dir', async () => {
  const { base } = await startServer();
  const index = await fetch(base + '/');
  expect(index.status).toBe(200);
  expect(await index.text()).toContain('simo endpoint test');
  const data = await fetch(base + '/data.js');
  expect(data.status).toBe(200);
  expect(await data.text()).toContain('const CATALOG');
});

/* ------------------------------------------------- /api/files routes --- */

it('GET /api/files/:id -> 200 [] for unknown-but-valid ids', async () => {
  const { base } = await startServer();
  const res = await fetch(base + '/api/files/nofiles-' + Date.now());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

it('GET /api/files with a path-like id -> 400', async () => {
  const { base } = await startServer();
  const res = await fetch(base + '/api/files/..%2Fevil');
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
});

it('GET /api/files/:id with a path-like name -> 400', async () => {
  const { base } = await startServer();
  const res = await fetch(base + '/api/files/stor-ok/..%2Fsecret');
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
});

it('GET /api/files/:id/:name -> 404 when nothing was stored', async () => {
  const { base } = await startServer();
  const res = await fetch(base
    + '/api/files/nofiles-' + Date.now() + '/today.net.xml');
  expect(res.status).toBe(404);
});

it('POST to the files API -> 405', async () => {
  const { base } = await startServer();
  const res = await fetch(base + '/api/files/some-id', { method: 'POST' });
  expect(res.status).toBe(405);
});

/* ------------------------------------------- db/bucket failure injection --- */
/* The opts.db / opts.bucket seams: a failing backend -> 500 BEFORE any
 * spawn, and nothing is written anywhere (the ownership check runs first,
 * so its injected db must exist; a put-side failure leaves the temp player
 * dir byte-identical). */

it('db failure -> 500 and no state change', async () => {
  const { base, td } = await startServer({
    sumoResolver: () => '/bin/true',        // must fail before any spawn
    db: {
      getSubmission: () => Promise.resolve(null),
      putUploadRefs: () => Promise.reject(new Error('db down')),
    },
  });
  const res = await post(base, postBody({ id: 'endp-dbfail' }));
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/db down/);
  expect(fs.readFileSync(path.join(td, 'data.js'), 'utf8'))
    .toBe('const OTHER_SIMS = [];\nconst CATALOG = [];\n');
  expect(await dbStore.getSubmission(pool, 'endp-dbfail')).toBeNull();
});

it('bucket failure -> 500 and no state change', async () => {
  const objects = new Map();
  const { base } = await startServer({
    sumoResolver: () => '/bin/true',
    bucket: {
      objects,
      putObjects: () => Promise.reject(new Error('bucket down')),
      deleteObjects: () => Promise.resolve(0),
      putReviewArtifacts: async () => {},
      getReviewStream: async () => null,
      getObjectBytes: async () => {
        throw Object.assign(new Error('nope'), { name: 'NoSuchKey' });
      },
    },
  });
  const res = await post(base, postBody({ id: 'endp-bktfail' }));
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/bucket down/);
  expect(await dbStore.getSubmission(pool, 'endp-bktfail')).toBeNull();
  expect(objects.size).toBe(0);
});

it('db list failure -> 500 on GET /api/files/:id', async () => {
  const { base } = await startServer({
    db: {
      getSubmission: () => Promise.resolve(null),
      listUploads: () => Promise.reject(new Error('db down')),
    },
  });
  const res = await fetch(base + '/api/files/endp-dblst');
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/db down/);
});

it.skipIf(!SUMO)('a simulated run persists its uploaded XMLs for /api/files', async () => {
  const { base } = await startServer();
  const res = await post(base, postBody({ id: 'endp-store' }));
  expect(res.status).toBe(200);

  /* Postgres: sims row + sim_files refs (key/url/size, never the bytes) */
  const row = (await pool.query('select * from sims where id = $1',
    ['endp-store'])).rows[0];
  expect(row.title).toBe('Endpoint test run');
  /* author from the verified token claims, not the request body */
  expect(row.author).toBe('qa user');
  expect(row.description).toBe('posted from endpoint test');
  const dbRefs = (await pool.query(
    'select name, object_key, size_bytes::int as size_bytes'
    + ' from sim_files where sim_id = $1 order by name', ['endp-store']))
    .rows;
  expect(dbRefs.map((r) => r.name))
    .toEqual(['demand.rou.xml', 'today.net.xml']);
  expect(dbRefs[0].object_key).toBe('uploads/endp-store/demand.rou.xml');
  expect(dbRefs[0].size_bytes).toBeGreaterThan(0);

  /* listing over HTTP (pending row -> owner token required) */
  const list = await fetch(base + '/api/files/endp-store', {
    headers: { Authorization: 'Bearer tok-qa' } });
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual(['demand.rou.xml', 'today.net.xml']);

  /* downloads: exact fixture bytes, served as XML (proxied from the
   * bucket seam) */
  const today = await fetch(base + '/api/files/endp-store/today.net.xml',
    { headers: { Authorization: 'Bearer tok-qa' } });
  expect(today.status).toBe(200);
  expect(today.headers.get('content-type')).toMatch(/text\/xml/);
  expect(await today.text()).toBe(NET_XML);
  const rou = await fetch(base + '/api/files/endp-store/demand.rou.xml',
    { headers: { Authorization: 'Bearer tok-qa' } });
  expect(rou.status).toBe(200);
  /* the server patches body.rouXml with the mandated aggressive-driving
   * vTypes BEFORE the bucket put — the stored bytes (and the resubmit
   * prefill) carry the block, not the raw fixture */
  const storedRou = await rou.text();
  expect(storedRou).not.toBe(ROU_XML);
  expect(storedRou).toContain('tau="0.5"');
  expect(storedRou).toContain('lcPushy="1.0"');
  expect(storedRou).toContain('<vType id="DEFAULT_VEHTYPE"');
  expect(storedRou).toContain('<flow');   // the original demand survives
});

it.skipIf(!SUMO)('a proposed net adds proposed.net.xml to the stored set', async () => {
  const { base } = await startServer();
  expect((await post(base, postBody({
    id: 'endp-store-ab',
    proposedNetXml: NET_XML,
  }))).status).toBe(200);
  const list = await fetch(base + '/api/files/endp-store-ab',
    { headers: { Authorization: 'Bearer tok-qa' } }).then((r) => r.json());
  expect(list).toEqual(['demand.rou.xml', 'proposed.net.xml', 'today.net.xml']);
});

it.skipIf(!SUMO)('re-simulating an id replaces its stored files', async () => {
  const { base } = await startServer();
  expect((await post(base, postBody({
    id: 'endp-store-idem',
    proposedNetXml: NET_XML,
  }))).status).toBe(200);
  expect((await fetch(base + '/api/files/endp-store-idem',
    { headers: { Authorization: 'Bearer tok-qa' } })
    .then((r) => r.json())).length).toBe(3);
  expect((await post(base, postBody({ id: 'endp-store-idem' }))).status)
    .toBe(200);
  const list = await fetch(base + '/api/files/endp-store-idem',
    { headers: { Authorization: 'Bearer tok-qa' } }).then((r) => r.json());
  expect(list).toEqual(['demand.rou.xml', 'today.net.xml']);
});

it.skipIf(!SUMO)('files are stored even when the simulation fails (422)', async () => {
  const { base } = await startServer();
  const res = await post(base, postBody({
    id: 'endp-store-422',
    todayNetXml: '<not-a-net>this is garbage</not-a-net>',
  }));
  expect(res.status).toBe(422);
  const list = await fetch(base + '/api/files/endp-store-422',
    { headers: { Authorization: 'Bearer tok-qa' } }).then((r) => r.json());
  expect(list).toEqual(['demand.rou.xml', 'today.net.xml']);
});

/* ------------------------------------------------- worker pool (phase 1) --- */
/* opts.pool seam — the pool replaces the simulate mutex: two simultaneous
 * POSTs must overlap (real SUMO, real pipeline) instead of serializing, and
 * a busy pool (POOL_BUSY) maps to 503 with the shared busy body. */

/* Real pool with `workers` slots, wrapped to record the max observed
 * concurrency (checked AFTER both requests settle — no races). */
function recordingPool(workers) {
  let running = 0;
  let max = 0;
  const inner = createPool({ workers });
  return {
    stats: () => inner.stats(),
    close: () => inner.close(),
    maxConcurrency: () => max,
    submit(fn) {
      return inner.submit(async () => {
        running++;
        max = Math.max(max, running);
        try {
          return await fn();
        } finally {
          running--;
        }
      });
    },
  };
}

it.skipIf(!SUMO)('two simultaneous simulates run concurrently via the pool (both 200, overlap proven)', async () => {
  const rec = recordingPool(2);
  const { base } = await startServer({ pool: rec });
  const [r1, r2] = await Promise.all([
    post(base, postBody({ id: 'endp-pool-a' })),
    post(base, postBody({ id: 'endp-pool-b' })),
  ]);
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
  expect(await r1.json()).toEqual({ id: 'endp-pool-a' });
  expect(await r2.json()).toEqual({ id: 'endp-pool-b' });
  expect(rec.maxConcurrency(),
    'both pipelines must have been in flight at once — the old mutex '
    + 'serialized them to max 1').toBeGreaterThanOrEqual(2);
  expect(rec.stats().running).toBe(0);
  rec.close();
});

it('a full pool -> 503 server busy', async () => {
  const busyPool = {
    stats: () => ({ workers: 1, running: 1, queued: 32 }),
    close: () => {},
    submit: () => Promise.reject(
      Object.assign(new Error('worker queue full'), { code: 'POOL_BUSY' })),
  };
  const { base } = await startServer({ pool: busyPool });
  const res = await post(base, postBody({ id: 'endp-poolbusy' }));
  expect(res.status).toBe(503);
  expect((await res.json()).error)
    .toBe('server busy — try again shortly');
  /* POOL_BUSY is the tag, not instanceof — a plain 500 must not mask it */
  expect(PoolBusyError).toBeTruthy();
});

it.skipIf(!SUMO)('review-artifact bucket failure -> 500, row stays pending + !sim_ready', async () => {
  const { base } = await startServer({
    bucket: {
      deleteObjects: () => Promise.resolve(0),
      putObjects: async (id, files) => {
        /* sources still upload (refs land) — only the REVIEW artifact
         * write fails */
        return files.map(({ name, text }) => ({
          name,
          object_key: bucketStore.objectKey(id, name),
          object_url: 's3://fake-bucket/' + name,
          size_bytes: Buffer.byteLength(text),
        }));
      },
      putReviewArtifacts: () => Promise.reject(new Error('bucket down')),
      getReviewStream: () => Promise.resolve(null),
      getObjectBytes: () => Promise.reject(
        Object.assign(new Error('nope'), { name: 'NoSuchKey' })),
    },
  });
  const res = await post(base, postBody({ id: 'endp-revart' }));
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/bucket down/);
  const row = await dbStore.getSubmission(pool, 'endp-revart');
  expect(row).toBeTruthy();
  expect(row.status).toBe('pending');
  expect(row.sim_ready).toBe(false);
  expect(row.entry_json).toBeNull();
});