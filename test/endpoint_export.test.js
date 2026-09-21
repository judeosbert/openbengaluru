/* POST /api/export-net endpoint test (plan: area export + worker pool,
 * phase 2) — REAL HTTP + REAL netconvert; the OSM fetch is a seam (no
 * network). No DB/bucket writes exist on this route, so the db/bucket
 * seams are empty stubs (createSimServer would otherwise construct real
 * backends from env and fail fast).
 *
 * Contract:
 *   POST { bbox: [minLat,minLng,maxLat,maxLng], name?, zoom? }
 *   Authorization: Bearer REQUIRED (401 before body parsing)
 *   400 bad bbox (validateBbox: shape/range/inversion/0.25° cap)
 *   400 OSM returned 400 (box too large upstream)
 *   422 netconvert stderr tail on nonzero exit
 *   500 netconvert undiscoverable
 *   502 other OSM status / fetch failure
 *   503 pool busy (POOL_BUSY) + OSM 429/509 (rate-limited)
 *   504 netconvert timeout
 *   200 application/zip attachment "<name>.zip" holding BOTH files:
 *   "<name>.net.xml" (with '<!-- simo:zoom=N -->' as line 2, the
 *   convert.sh awk step) AND "<name>.osm.xml" (the same fetched OSM the
 *   conversion consumed, zoom-stamped) — one request, both artifacts,
 *   verified through the system unzip.
 *
 * Skips the netconvert-running cases when the binary is undiscoverable
 * (mirrors test/endpoint.test.js's SUMO skip-guard).
 */
import { it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSimServer } from '../server.js';
import { findNetconvert } from '../tools/sumo_geom.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const FIXDIR = path.join(PLAYER_ROOT, 'test', 'fixtures');
const OSM_XML = fs.readFileSync(path.join(FIXDIR, 'mini.osm.xml'), 'utf8');
const NETCONVERT = findNetconvert();
const UNZIP = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function fakeVerifyToken(token) {
  if (token === 'tok-qa') {
    return { uid: 'qa', name: 'qa user', email: 'qa@x.test' };
  }
  throw new Error('bad token');
}

function osmResponse(status, text) {
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

const created = [];
const ZIPDIRS = [];

function startServer(opts = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-expp-'));
  const distDir = path.join(td, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'),
    '<!DOCTYPE html><html><body>simo export test</body></html>');
  const server = createSimServer({
    playerDir: td,
    distDir,
    rootDir: PLAYER_ROOT,
    db: {},        // export-net never touches the DB — stub out the seams
    bucket: {},    // …and the bucket (construct-time fail-fast otherwise)
    verifyToken: opts.verifyToken || fakeVerifyToken,
    mailer: { send: () => Promise.resolve() },   // no SMTP env in tests
    fetchOsm: opts.fetchOsm || (() => Promise.resolve(osmResponse(200, OSM_XML))),
    netconvertResolver: opts.netconvertResolver
      ?? (NETCONVERT ? () => NETCONVERT : () => null),
    ...(opts.pool ? { pool: opts.pool } : {}),
    ...opts,
  });
  created.push({ server, td });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, td, base: 'http://127.0.0.1:' + port });
    });
  });
}

afterAll(async () => {
  for (const { server, td } of created) {
    server.close();
    fs.rmSync(td, { recursive: true, force: true });
  }
  for (const td of ZIPDIRS) {
    fs.rmSync(td, { recursive: true, force: true });
  }
});

function exportReq(base, body, token = 'tok-qa') {
  return fetch(base + '/api/export-net', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/* The system unzip reads the zip back — a wrong CRC or a broken central
 * directory fails against the real tool, not a reimplementation. */
async function saveZip(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-expp-zip-'));
  ZIPDIRS.push(td);
  const p = path.join(td, 'out.zip');
  fs.writeFileSync(p, buf);
  return p;
}

/* ------------------------------------------------------------------ tests */

it('missing Authorization header -> 401, before any body validation', async () => {
  const { base } = await startServer();
  const res = await exportReq(base, { bbox: [12.94, 77.71, 12.95, 77.72] },
    null);
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('authentication failed');
});

it('invalid token -> 401', async () => {
  const { base } = await startServer();
  const res = await exportReq(base,
    { bbox: [12.94, 77.71, 12.95, 77.72] }, 'not-the-token');
  expect(res.status).toBe(401);
  expect((await res.json()).error).toBe('authentication failed');
});

it('invalid JSON body -> 400', async () => {
  const { base } = await startServer();
  const res = await exportReq(base, '{not json');
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBeTruthy();
});

it.each([
  ['not an array', 'hello world'],
  ['wrong length', [12.94, 77.71, 12.95]],
  ['non-numeric', ['a', 'b', 'c', 'd']],
  ['lat out of range', [91, 77.71, 92, 77.72]],
  ['lng out of range', [12.94, 181, 12.95, 182]],
  ['inverted lat', [12.95, 77.71, 12.94, 77.72]],
  ['inverted lng', [12.94, 77.72, 12.95, 77.71]],
  ['lat side over 0.25°', [12.9, 77.7, 13.2, 77.75]],
  ['lng side over 0.25°', [12.9, 77.7, 12.95, 78.0]],
])('bad bbox (%s) -> 400, OSM never fetched', async (label, bbox) => {
  const { base } = await startServer();
  const res = await exportReq(base, { bbox });
  expect(res.status, label).toBe(400);
  expect((await res.json()).error, label).toBeTruthy();
});

it('OSM 400 -> 400 with the smaller-box hint', async () => {
  const { base } = await startServer({
    fetchOsm: () => Promise.resolve(osmResponse(400, 'Way too big')),
  });
  const res = await exportReq(base,
    { bbox: [12.94, 77.71, 12.95, 77.72] });
  expect(res.status).toBe(400);
  expect((await res.json()).error)
    .toMatch(/box too large/);
});

it('OSM 429 -> 503 rate-limited', async () => {
  const { base } = await startServer({
    fetchOsm: () => Promise.resolve(osmResponse(429, 'slow down')),
  });
  const res = await exportReq(base,
    { bbox: [12.94, 77.71, 12.95, 77.72] });
  expect(res.status).toBe(503);
  expect((await res.json()).error).toMatch(/rate-limited/i);
});

it('other OSM statuses -> 502', async () => {
  const { base } = await startServer({
    fetchOsm: () => Promise.resolve(osmResponse(500, 'osm broken')),
  });
  const res = await exportReq(base,
    { bbox: [12.94, 77.71, 12.95, 77.72] });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBeTruthy();
});

it('fetchOsm throwing (timeout/network) -> 502', async () => {
  const { base } = await startServer({
    fetchOsm: () => Promise.reject(new Error('The operation timed out')),
  });
  const res = await exportReq(base,
    { bbox: [12.94, 77.71, 12.95, 77.72] });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBeTruthy();
});

it('netconvert undiscoverable -> 500 with the install hint', async () => {
  const { base } = await startServer({ netconvertResolver: () => null });
  const res = await exportReq(base,
    { bbox: [12.94, 77.71, 12.95, 77.72] });
  expect(res.status).toBe(500);
  expect((await res.json()).error).toMatch(/netconvert/);
});

it('a full pool -> 503 server busy (same body as simulate)', async () => {
  const busyPool = {
    stats: () => ({ workers: 1, running: 1, queued: 32 }),
    close: () => {},
    submit: () => Promise.reject(
      Object.assign(new Error('worker queue full'), { code: 'POOL_BUSY' })),
  };
  const { base } = await startServer({ pool: busyPool });
  const res = await exportReq(base,
    { bbox: [12.94, 77.71, 12.95, 77.72] });
  expect(res.status).toBe(503);
  expect((await res.json()).error).toBe('server busy — try again shortly');
});

it.skipIf(!NETCONVERT || !UNZIP)('happy path: 200 zip attachment carrying BOTH the .net.xml and the .osm.xml', async () => {
  const { base } = await startServer();
  const res = await exportReq(base, {
    bbox: [12.94, 77.71, 12.95, 77.72],
    name: 'test area',
    zoom: 14,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/zip');
  expect(res.headers.get('content-disposition'))
    .toBe('attachment; filename="test-area.zip"');
  const p = await saveZip(res);
  const names = execFileSync('unzip', ['-Z1', p]).toString('utf8')
    .split('\n').filter(Boolean).sort();
  expect(names).toEqual(['test-area.net.xml', 'test-area.osm.xml']);

  /* the net file: today's contract, unchanged — zoom stamp on line 2 */
  const net = execFileSync('unzip', ['-p', p, 'test-area.net.xml'])
    .toString('utf8');
  expect(net).toContain('<net ');
  expect(net.split('\n')[1], 'zoom stamp must be line 2 (convert.sh '
    + 'awk step: NR==1 print + comment)').toBe('<!-- simo:zoom=14 -->');
  /* real net output: SUMO location element with the fixture's bounds */
  expect(net).toContain('<location ');

  /* the osm file: the SAME fetched OSM the conversion consumed */
  const osm = execFileSync('unzip', ['-p', p, 'test-area.osm.xml'])
    .toString('utf8');
  expect(osm).toContain('<bounds ');
  expect(osm).toContain('<!-- simo:zoom=14 -->');
});

it.skipIf(!NETCONVERT)('garbage OSM -> 422 with the netconvert stderr tail', async () => {
  const { base } = await startServer({
    fetchOsm: () => Promise.resolve(
      osmResponse(200, '<not-osm>this is garbage</not-osm>')),
  });
  const res = await exportReq(base,
    { bbox: [12.94, 77.71, 12.95, 77.72] });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
  expect(body.error.length).toBeGreaterThan(0);
});

it.skipIf(!NETCONVERT || !UNZIP)('zoom is clamped into 3..19 (stamped inside the zip)', async () => {
  const { base } = await startServer();
  for (const [zoom, stamped] of [[25, 19], [1, 3]]) {
    const res = await exportReq(base, {
      bbox: [12.94, 77.71, 12.95, 77.72], zoom,
    });
    expect(res.status).toBe(200);
    const p = await saveZip(res);
    const net = execFileSync('unzip', ['-p', p, 'area.net.xml'])
      .toString('utf8');
    expect(net.split('\n')[1]).toBe('<!-- simo:zoom=' + stamped + ' -->');
  }
});
