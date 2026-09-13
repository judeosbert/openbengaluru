#!/usr/bin/env node
/* simo-player local server: static hosting + POST /api/simulate.
 *
 * The endpoint runs the real verified pipeline as subprocesses
 * (tools/pack_run.js -> tools/dev_inject.js), persists the entry into the
 * player dir (public/data.js CATALOG + public/streams/<id>.js), and the
 * browser reloads into the real simulation. The pg/S3 persistence handlers
 * are async; a promise-chain mutex still inlines whole simulate requests —
 * concurrent simulates serialize (the pipeline itself blocks on spawnSync).
 * A small 900 s net runs in seconds; the hard cap is ~5 min.
 *
 *   node server.js            # PORT env overrides 8787
 *
 * Contract (plan: real SUMO simulation for wizard-submitted entries):
 *   POST /api/simulate  { id, title, author, desc, rouXml, todayNetXml,
 *                         proposedNetXml?, anchor?, rotation? }  (<= 25 MB)
 *   200 { id }                                   after both tools succeeded
 *   400 { error }                                bad/missing fields
 *   413 { error }                                body over the cap
 *   422 { error: <stderr tail> }                 SUMO/pack failure
 *   500 { error: 'sumo binary not found …' }     SUMO undiscoverable
 *   500 { error: 'file storage failed …' }       bucket/DB persistence failed
 *   504 { error }                                tool timeout
 *
 * Upload storage (bucket.js + db.js): after validateBody the posted XMLs
 * are PUT to an S3-compatible bucket under uploads/<id>/<name> and
 * referenced in Postgres — sims metadata (title/author/desc/anchor/
 * rotation) + sim_files rows (object key + url + size, never the bytes) —
 * so the wizard's sources stay retrievable after the per-request tempdir
 * is gone. The bucket stays private: downloads are proxied by the server;
 * creds never leave the process.
 *   GET  /api/files/:id         -> 200 [names…] ([] for unknown-but-valid id)
 *   GET  /api/files/:id/:name   -> 200 <object bytes>; 404 when absent
 *   400 { error }               invalid id / name (slug + no .., slashes or
 *                               leading dots — checked BEFORE any lookup)
 *   405 { error }               non-GET on the files API
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findSumo } from './tools/sumo_geom.js';
import * as dbStore from './db.js';
import * as bucketStore from './bucket.js';

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const SIMULATE_TIMEOUT_MS = 5 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.xml': 'text/xml; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* Last lines of a tool's stderr — the 422 error payload. */
function tail(s) {
  return String(s || '').trim().split('\n').slice(-8).join('\n').slice(-800);
}

/* Download-name guard: reject '..', any slash, and leading dots BEFORE any
 * DB lookup or key use. Only the three fixed stored names can ever match a
 * sim_files row; this is the route-level 400 guard on top. */
function validName(name) {
  return typeof name === 'string' && name.length > 0
    && !name.startsWith('.')
    && !/[/\\]/.test(name);
}

function validateBody(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return 'JSON object body required';
  }
  if (typeof b.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(b.id)) {
    return 'id must be a slug-style string (lowercase letters, digits, '
      + 'hyphens)';
  }
  if (!b.title || typeof b.title !== 'string') return 'title is required';
  if (typeof b.rouXml !== 'string' || !b.rouXml.trim()) {
    return 'rouXml is required';
  }
  if (typeof b.todayNetXml !== 'string' || !b.todayNetXml.trim()) {
    return 'todayNetXml is required';
  }
  if (b.proposedNetXml != null && typeof b.proposedNetXml !== 'string') {
    return 'proposedNetXml must be a string';
  }
  if (b.anchor != null && (!Array.isArray(b.anchor) || b.anchor.length !== 2
      || !b.anchor.every(Number.isFinite))) {
    return 'anchor must be [lat, lng]';
  }
  if (b.rotation != null && !Number.isFinite(b.rotation)) {
    return 'rotation must be a number';
  }
  if (b.desc != null && typeof b.desc !== 'string') {
    return 'desc must be a string';
  }
  return null;
}

/* Bound backends — the injection seams (mirror of the retired
 * opts.storage): createSimServer({ db, bucket }) swaps the whole backend so
 * tests can fail it or fake it. Defaults construct from env and fail fast
 * (createPoolFromEnv / createS3FromEnv list missing vars). */
function makeDbApi(pool) {
  return {
    putUploadRefs: (id, body, refs) =>
      dbStore.putUploadRefs(pool, id, body, refs),
    listUploads: (id) => dbStore.listUploads(pool, id),
    getUploadRef: (id, name) => dbStore.getUploadRef(pool, id, name),
  };
}

function makeBucketApi(s3) {
  return {
    putObjects: (id, files) => bucketStore.putObjects(s3, id, files),
    deleteObjects: (id) => bucketStore.deleteObjects(s3, id),
    getObjectBytes: (key) => bucketStore.getObjectBytes(s3, key),
  };
}

export function createSimServer(opts = {}) {
  const rootDir = opts.rootDir || SERVER_ROOT;
  const playerDir = opts.playerDir || path.join(rootDir, 'public');
  const distDir = opts.distDir || path.join(rootDir, 'dist');
  const dataPath = path.join(playerDir, 'data.js');
  const streamsDir = path.join(playerDir, 'streams');
  const resolveSumo = opts.sumoResolver || findSumo;
  const maxBodyBytes = opts.maxBodyBytes || MAX_BODY_BYTES;
  const timeoutMs = opts.timeoutMs || SIMULATE_TIMEOUT_MS;
  const dbApi = opts.db || makeDbApi(dbStore.createPoolFromEnv());
  const bucketApi = opts.bucket
    || makeBucketApi(bucketStore.createS3FromEnv());
  const packRunJs = path.join(rootDir, 'tools', 'pack_run.js');
  const devInjectJs = path.join(rootDir, 'tools', 'dev_inject.js');

  /* concurrent simulates serialize: each queued task runs the WHOLE
   * request — validation, bucket/DB persistence, pipeline — strictly after
   * the previous one finished. The chain never rejects. */
  let simChain = Promise.resolve();
  function enqueueSimulate(task) {
    const run = simChain.then(task);
    simChain = run.then(() => {}, () => {});
    return run;
  }

  function serveStatic(pathname, res) {
    let p = pathname;
    try { p = decodeURIComponent(p); } catch { /* keep raw */ }
    if (p === '/') p = '/index.html';
    /* player dir first: data.js + streams/ are live-injected between
     * builds; dist/ holds the built app assets */
    for (const base of [playerDir, distDir]) {
      const fp = path.normalize(path.join(base, p));
      if (fp !== base && !fp.startsWith(base + path.sep)) continue;
      let st = null;
      try { st = fs.statSync(fp); } catch { /* try next root */ }
      if (st && st.isFile()) {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(fp).toLowerCase()]
            || 'application/octet-stream',
        });
        res.end(fs.readFileSync(fp));
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + p
      + (fs.existsSync(path.join(distDir, 'index.html'))
        ? '' : ' — run `npm run build` first'));
  }

  function handleSimulate(req, res) {
    const started = Date.now();
    /* one log line per simulate with the outcome — the failure toast in the
     * browser mirrors body.error, so this is the server-side trace */
    const respond = (status, body) => {
      process.stdout.write(`POST /api/simulate -> ${status} `
        + `${((Date.now() - started) / 1000).toFixed(1)}s`
        + (status >= 400
          ? ' — ' + String(body.error || '').split('\n')[0].slice(0, 200)
          : '') + '\n');
      sendJson(res, status, body);
    };
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (c) => {
      if (rejected) return;
      size += c.length;
      if (size > maxBodyBytes) {
        rejected = true;
        respond(413,
          { error: 'body too large (max ' + maxBodyBytes + ' bytes)' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => { /* client vanished mid-upload */ });
    req.on('end', () => {
      if (rejected) return;
      enqueueSimulate(() => processSimulate(req, res, chunks, respond))
        .catch((e) => {
          if (!res.headersSent) {
            sendJson(res, 500, { error: String((e && e.message) || e) });
          }
        });
    });
  }

  async function processSimulate(req, res, chunks, respond) {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return respond(400, { error: 'invalid JSON body' });
    }
    const invalid = validateBody(body);
    if (invalid) return respond(400, { error: invalid });

    const sumo = resolveSumo();
    if (!sumo) {
      return respond(500, { error: 'sumo binary not found — install '
        + 'SUMO (https://sumo.dlr.de/docs/Installing.html) or set '
        + 'SUMO_HOME' });
    }

    /* persist the uploaded sources AFTER validation, BEFORE the pipeline:
     * a bucket/DB failure -> 500 and dev_inject (the only catalog writer,
     * last) never runs, so the catalog stays untouched. Files are kept even
     * when the simulation itself fails (422) — the sources are the user's
     * data, the tempdir is not. A re-put deletes the superseded bucket
     * objects best-effort first (log, don't fail): a failed cleanup leaves
     * the DB consistent and the next re-put cleans again. */
    const files = [
      { name: bucketStore.FILE_NAMES.todayNet, text: body.todayNetXml },
      { name: bucketStore.FILE_NAMES.demand, text: body.rouXml },
      ...(body.proposedNetXml
        ? [{ name: bucketStore.FILE_NAMES.proposedNet,
            text: body.proposedNetXml }]
        : []),
    ];
    try {
      try {
        await bucketApi.deleteObjects(body.id);
      } catch (e) {
        process.stdout.write('bucket cleanup skipped (best-effort): '
          + String((e && e.message) || e) + '\n');
      }
      const refs = await bucketApi.putObjects(body.id, files);
      await dbApi.putUploadRefs(body.id, body, refs);
    } catch (e) {
      return respond(500, { error: 'file storage failed: '
        + String((e && e.message) || e) });
    }

    /* per-request tempdir; cleaned on every exit path. dev_inject is the
     * only catalog/stream writer and runs LAST — a failure anywhere
     * before it leaves the player dir untouched. */
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-sim-'));
    try {
      const todayNet = path.join(td, 'today.net.xml');
      const rou = path.join(td, 'demand.rou.xml');
      fs.writeFileSync(todayNet, body.todayNetXml);
      fs.writeFileSync(rou, body.rouXml);
      const packOut = path.join(td, 'out.simo.json');
      /* one demand file serves both scenarios (single DEMAND slot) */
      const scenArgs = ['--scenario', 'today=' + todayNet + ':' + rou];
      if (body.proposedNetXml) {
        const proposedNet = path.join(td, 'proposed.net.xml');
        fs.writeFileSync(proposedNet, body.proposedNetXml);
        scenArgs.push('--scenario', 'proposed=' + proposedNet + ':' + rou);
      }

      const pr = spawnSync(process.execPath,
        [packRunJs, ...scenArgs, '-o', packOut, '--sumo', sumo],
        { encoding: 'utf8', timeout: timeoutMs });
      if (pr.signal) {
        return respond(504, { error: 'simulation timed out' });
      }
      if (pr.status !== 0) {
        return respond(422,
          { error: tail(pr.stderr) || 'pack_run exited ' + pr.status });
      }

      const di = spawnSync(process.execPath,
        [devInjectJs, packOut,
          '--id', body.id,
          '--title', body.title,
          ...(body.author ? ['--author', body.author] : []),
          '--net', todayNet,
          '--player-dir', playerDir,
          ...(body.desc ? ['--desc', body.desc] : []),
          ...(body.anchor ? ['--anchor', body.anchor.join(',')] : []),
          ...(body.rotation ? ['--rotation', String(body.rotation)] : [])],
        { encoding: 'utf8', timeout: timeoutMs });
      if (di.signal) {
        return respond(504, { error: 'simulation timed out' });
      }
      if (di.status !== 0) {
        return respond(500,
          { error: tail(di.stderr) || 'dev_inject exited ' + di.status });
      }
      return respond(200, { id: body.id });
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  }

  /* GET /api/files/:id [/:name] — listing and download of the stored
   * uploads. Segments are decoded and validated per-segment (URL %2F tricks
   * never reach a key or a DB query). One log line per request, matching
   * simulate. */
  async function handleFiles(pathname, res) {
    const started = Date.now();
    const respond = (status, headers, payload) => {
      process.stdout.write(`GET ${pathname} -> ${status} `
        + `${Date.now() - started}ms\n`);
      if (headers) {
        res.writeHead(status, headers);
        res.end(payload);
      } else {
        sendJson(res, status, payload);
      }
    };
    const segs = pathname.split('/').filter(Boolean).slice(2);
    const decode = (s) => {
      try { return decodeURIComponent(s); } catch { return null; }
    };
    const id = segs.length ? decode(segs[0]) : null;
    if (typeof id !== 'string' || !bucketStore.ID_RE.test(id)) {
      return respond(400, null, { error: segs.length
        ? 'invalid id' : 'id required' });
    }
    if (segs.length === 1) {
      let files;
      try {
        files = await dbApi.listUploads(id);
      } catch (e) {
        return respond(500, null, { error: String((e && e.message) || e) });
      }
      return respond(200, null, files);
    }
    if (segs.length > 2) {
      return respond(400, null, { error: 'invalid name' });
    }
    const name = decode(segs[1]);
    if (!validName(name)) {
      return respond(400, null, { error: 'invalid name' });
    }
    let ref;
    try {
      ref = await dbApi.getUploadRef(id, name);
    } catch (e) {
      return respond(500, null, { error: String((e && e.message) || e) });
    }
    if (!ref) {
      return respond(404, null, { error: 'not found: ' + name });
    }
    let buf;
    try {
      buf = await bucketApi.getObjectBytes(ref.object_key);
    } catch (e) {
      return respond(500, null, { error: String((e && e.message) || e) });
    }
    return respond(200, {
      'Content-Type': MIME[path.extname(name).toLowerCase()]
        || 'application/octet-stream',
      'Content-Length': buf.length,
    }, buf);
  }

  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && u.pathname === '/api/simulate') {
      try {
        handleSimulate(req, res);
      } catch (e) {
        sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      return;
    }
    if (u.pathname === '/api/files' || u.pathname.startsWith('/api/files/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      handleFiles(u.pathname, res).catch((e) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: String((e && e.message) || e) });
        }
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    try {
      serveStatic(u.pathname, res);
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) });
    }
  });
}

export function main() {
  const port = Number(process.env.PORT) || 8787;
  const server = createSimServer();
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write('simo-player server -> listening on 0.0.0.0:' + port
      + ' (LAN-reachable at http://<your-ip>:' + port + ')'
      + '\nReal simulations: POST /api/simulate (runs SUMO via '
      + 'tools/pack_run.js).\n');
  });
  return server;
}

if (process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(
      import.meta.url))) {
  main();
}