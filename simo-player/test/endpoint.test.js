/* POST /api/simulate endpoint test — REAL HTTP, REAL SUMO, REAL Postgres
 * (the ${PGDATABASE}_test database via test/helpers/pgTest.js) and an
 * in-memory fake for the bucket seam (per plan: no MinIO docker default;
 * opt-in real run in test/bucket.test.js). Port of the plan's validation
 * contract:
 *
 *   POST a fixture net+rou -> 200, stream + catalog on disk, sims row +
 *   sim_files refs in the test DB; garbage net -> 422; undiscoverable SUMO
 *   -> 500; oversize body -> 413; bad input -> 400; failing db/bucket
 *   backend -> 500 via the injected opts.db / opts.bucket seams.
 *
 * Skips the SUMO-running cases when the binary is undiscoverable (the rest
 * of the suite still runs). The server injects into a TEMP player dir,
 * never the real public/.
 */
import { it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSimServer } from '../server.js';
import { findSumo } from '../tools/sumo_geom.js';
import * as dbStore from '../db.js';
import * as bucketStore from '../bucket.js';
import { readDataConsts, PLAYER_ROOT } from './helpers/dataConsts.js';
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

/* ------------------------------------------------------------- harness --- */

const created = [];

/* Real db.js API bound to the shared test-db pool. */
function dbApi() {
  return {
    putUploadRefs: (id, body, refs) =>
      dbStore.putUploadRefs(pool, id, body, refs),
    listUploads: (id) => dbStore.listUploads(pool, id),
    getUploadRef: (id, name) => dbStore.getUploadRef(pool, id, name),
  };
}

/* In-memory bucket seam twin — putObjects returns the same ref shape as
 * bucket.js (real key building + guards), bytes stay in a Map. */
function fakeBucketApi() {
  const objects = new Map();
  return {
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

function startServer(opts = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-endp-'));
  fs.mkdirSync(path.join(td, 'streams'));
  fs.writeFileSync(path.join(td, 'data.js'),
    'const OTHER_SIMS = [];\nconst CATALOG = [];\n');
  const distDir = path.join(td, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'),
    '<!DOCTYPE html><html><body>simo endpoint test</body></html>');
  const server = createSimServer({
    playerDir: td,
    distDir,
    rootDir: PLAYER_ROOT,                   // simo-player/ — the real tools
    db: dbApi(),                            // real refs on the TEST database
    bucket: fakeBucketApi(),                // bytes in memory, keys real
    ...(opts.sumoResolver ? {} : { sumoResolver: () => SUMO }),
    ...opts,
  });
  created.push({ server, td });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, td, port, base: 'http://127.0.0.1:' + port });
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
    ...over,
  });
}

function post(base, data, extra = {}) {
  return fetch(base + '/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data,
    ...extra,
  });
}

function readStreamFile(td, id) {
  const src = fs.readFileSync(path.join(td, 'streams', id + '.js'), 'utf8');
  const m = src.match(/^window\.__simoStreamCallback\('([^']+)',\s*(\{.*\})\);\s*$/s);
  expect(m, 'stream file must be a __simoStreamCallback JSONP payload').not.toBeNull();
  return { id: m[1], payload: JSON.parse(m[2]) };
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

it.skipIf(!SUMO)('POST /api/simulate runs the real pipeline: 200 + stream + catalog', async () => {
  const { base, td } = await startServer();
  const res = await post(base, postBody({ id: 'endp-happy' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: 'endp-happy' });

  /* stream file on disk: JSONP contract, 900 real frames, real vehicles */
  const { id, payload } = readStreamFile(td, 'endp-happy');
  expect(id).toBe('endp-happy');
  expect(payload.nFrames).toBe(900);
  expect(Object.keys(payload.scenarios).sort()).toEqual(['today']);
  expect(typeof payload.scenarios.today.frames).toBe('string');
  expect(vehicleFrameCount(payload.scenarios.today.frames))
    .toBeGreaterThan(10);                     // 26 vehicles departed over 600 s

  /* catalog entry: one-line CATALOG format preserved, id present */
  const src = fs.readFileSync(path.join(td, 'data.js'), 'utf8');
  expect(src).toMatch(/^const CATALOG = .*;\s*$/m);
  const catalog = readDataConsts(path.join(td, 'data.js')).CATALOG;
  const e = catalog.find((x) => x.id === 'endp-happy');
  expect(e, 'data.js must contain the simulated id').toBeTruthy();
  expect(e.title).toBe('Endpoint test run');
  expect(e.author).toBe('qa');
  expect(e.desc).toBe('posted from endpoint test');
  expect(e.nFrames).toBe(900);
  expect(e.demand).toBe(150);                 // 120 + 30 veh/h from the fixture
  /* the net carries origBoundary 0,0,50,50 -> geo-locked placement comes
   * from the net bounds, NOT the posted wizard anchor */
  expect(e.anchor).toEqual([25, 25]);
  expect(e.rotation).toBe(0);
  expect(e.scenarios.today.geoLocked).toBe(true);
  expect(e.scenarios.today.stats, 'stats must ride inline').toBeTruthy();

  /* the server also serves the patched bundle over HTTP */
  const served = await fetch(base + '/data.js').then((r) => r.text());
  expect(served).toContain('endp-happy');
  const streamServed = await fetch(base + '/streams/endp-happy.js');
  expect(streamServed.status).toBe(200);
  expect(await streamServed.text()).toContain("__simoStreamCallback('endp-happy'");
});

it.skipIf(!SUMO)('a proposed net produces the A/B pair', async () => {
  const { base, td } = await startServer();
  const res = await post(base, postBody({
    id: 'endp-ab',
    proposedNetXml: NET_XML,
  }));
  expect(res.status).toBe(200);
  const { payload } = readStreamFile(td, 'endp-ab');
  expect(Object.keys(payload.scenarios).sort()).toEqual(['proposed', 'today']);
  const e = readDataConsts(path.join(td, 'data.js'))
    .CATALOG.find((x) => x.id === 'endp-ab');
  expect(Object.keys(e.scenarios).sort()).toEqual(['proposed', 'today']);
});

it.skipIf(!SUMO)('re-simulating the same id replaces (idempotent)', async () => {
  const { base, td } = await startServer();
  expect((await post(base, postBody({ id: 'endp-idem' }))).status).toBe(200);
  expect((await post(base, postBody({ id: 'endp-idem', title: 'Replaced' })))
    .status).toBe(200);
  const catalog = readDataConsts(path.join(td, 'data.js')).CATALOG;
  const matches = catalog.filter((x) => x.id === 'endp-idem');
  expect(matches.length).toBe(1);
  expect(matches[0].title).toBe('Replaced');
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

it.skipIf(!SUMO)('failed simulate writes no catalog entry', async () => {
  const { base, td } = await startServer();
  const res = await post(base, postBody({
    id: 'endp-nopartial',
    todayNetXml: '<not-a-net>this is garbage</not-a-net>',
  }));
  expect(res.status).toBe(422);
  const catalog = readDataConsts(path.join(td, 'data.js')).CATALOG;
  expect(catalog.find((x) => x.id === 'endp-nopartial')).toBeUndefined();
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
/* The opts.db / opts.bucket seams replace the retired opts.storage seam:
 * a failing backend -> 500 'file storage failed: …' BEFORE any spawn, and
 * the catalog stays untouched (dev_inject, the only catalog writer, is last
 * and never runs). */

it('db failure -> 500 and no catalog mutation', async () => {
  const { base, td } = await startServer({
    sumoResolver: () => '/bin/true',        // must fail before any spawn
    db: { putUploadRefs: () => Promise.reject(new Error('db down')) },
  });
  const res = await post(base, postBody({ id: 'endp-dbfail' }));
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/db down/);
  const catalog = readDataConsts(path.join(td, 'data.js')).CATALOG;
  expect(catalog.find((x) => x.id === 'endp-dbfail')).toBeUndefined();
});

it('bucket failure -> 500 and no catalog mutation', async () => {
  const { base, td } = await startServer({
    sumoResolver: () => '/bin/true',
    bucket: { putObjects: () => Promise.reject(new Error('bucket down')) },
  });
  const res = await post(base, postBody({ id: 'endp-bktfail' }));
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/bucket down/);
  const catalog = readDataConsts(path.join(td, 'data.js')).CATALOG;
  expect(catalog.find((x) => x.id === 'endp-bktfail')).toBeUndefined();
});

it('db list failure -> 500 on GET /api/files/:id', async () => {
  const { base } = await startServer({
    db: { listUploads: () => Promise.reject(new Error('db down')) },
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
  expect(row.author).toBe('qa');
  expect(row.description).toBe('posted from endpoint test');
  const dbRefs = (await pool.query(
    'select name, object_key, size_bytes::int as size_bytes'
    + ' from sim_files where sim_id = $1 order by name', ['endp-store']))
    .rows;
  expect(dbRefs.map((r) => r.name))
    .toEqual(['demand.rou.xml', 'today.net.xml']);
  expect(dbRefs[0].object_key).toBe('uploads/endp-store/demand.rou.xml');
  expect(dbRefs[0].size_bytes).toBeGreaterThan(0);

  /* listing over HTTP */
  const list = await fetch(base + '/api/files/endp-store');
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual(['demand.rou.xml', 'today.net.xml']);

  /* downloads: exact fixture bytes, served as XML (proxied from the
   * bucket seam) */
  const today = await fetch(base + '/api/files/endp-store/today.net.xml');
  expect(today.status).toBe(200);
  expect(today.headers.get('content-type')).toMatch(/text\/xml/);
  expect(await today.text()).toBe(NET_XML);
  const rou = await fetch(base + '/api/files/endp-store/demand.rou.xml');
  expect(rou.status).toBe(200);
  expect(await rou.text()).toBe(ROU_XML);
});

it.skipIf(!SUMO)('a proposed net adds proposed.net.xml to the stored set', async () => {
  const { base } = await startServer();
  expect((await post(base, postBody({
    id: 'endp-store-ab',
    proposedNetXml: NET_XML,
  }))).status).toBe(200);
  const list = await fetch(base + '/api/files/endp-store-ab')
    .then((r) => r.json());
  expect(list).toEqual(['demand.rou.xml', 'proposed.net.xml', 'today.net.xml']);
});

it.skipIf(!SUMO)('re-simulating an id replaces its stored files', async () => {
  const { base } = await startServer();
  expect((await post(base, postBody({
    id: 'endp-store-idem',
    proposedNetXml: NET_XML,
  }))).status).toBe(200);
  expect((await fetch(base + '/api/files/endp-store-idem')
    .then((r) => r.json())).length).toBe(3);
  expect((await post(base, postBody({ id: 'endp-store-idem' }))).status)
    .toBe(200);
  const list = await fetch(base + '/api/files/endp-store-idem')
    .then((r) => r.json());
  expect(list).toEqual(['demand.rou.xml', 'today.net.xml']);
});

it.skipIf(!SUMO)('files are stored even when the simulation fails (422)', async () => {
  const { base } = await startServer();
  const res = await post(base, postBody({
    id: 'endp-store-422',
    todayNetXml: '<not-a-net>this is garbage</not-a-net>',
  }));
  expect(res.status).toBe(422);
  const list = await fetch(base + '/api/files/endp-store-422')
    .then((r) => r.json());
  expect(list).toEqual(['demand.rou.xml', 'today.net.xml']);
});
