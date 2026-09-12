/* POST /api/simulate endpoint test — REAL HTTP, REAL SUMO, REAL files on
 * disk (no mocks). Port of the plan's validation contract:
 *
 *   POST a fixture net+rou -> 200, streams/<id>.js on disk, data.js contains
 *   the id, stream frames are real packed vehicles; garbage net -> 422;
 *   undiscoverable SUMO -> 500; oversize body -> 413; bad input -> 400.
 *
 * Skips the SUMO-running cases when the binary is undiscoverable (the rest
 * of the suite still runs). The server injects into a TEMP player dir, never
 * the real public/.
 */
import { it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSimServer } from '../server.js';
import { findSumo } from '../tools/sumo_geom.js';
import { readDataConsts, PLAYER_ROOT } from './helpers/dataConsts.js';

const FIXDIR = path.join(PLAYER_ROOT, 'test', 'fixtures');
const ROU_XML = fs.readFileSync(path.join(FIXDIR, 'mini.rou.xml'), 'utf8');
const NET_XML = fs.readFileSync(path.join(FIXDIR, 'mini.net.xml'), 'utf8');
const SUMO = findSumo();

/* ------------------------------------------------------------- harness --- */

const created = [];

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

afterAll(() => {
  for (const { server, td } of created) {
    server.close();
    fs.rmSync(td, { recursive: true, force: true });
  }
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
