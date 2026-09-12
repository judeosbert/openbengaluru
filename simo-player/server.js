#!/usr/bin/env node
/* simo-player local server: static hosting + POST /api/simulate.
 *
 * The endpoint runs the real verified pipeline as subprocesses
 * (tools/pack_run.js -> tools/dev_inject.js), persists the entry into the
 * player dir (public/data.js CATALOG + public/streams/<id>.js), and the
 * browser reloads into the real simulation. Synchronous by design — the
 * whole handler runs inline, so concurrent requests serialize on the event
 * loop. A small 900 s net runs in seconds; the hard cap is ~5 min.
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
 *   504 { error }                                tool timeout
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findSumo } from './tools/sumo_geom.js';

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
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* Last lines of a tool's stderr — the 422 error payload. */
function tail(s) {
  return String(s || '').trim().split('\n').slice(-8).join('\n').slice(-800);
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

export function createSimServer(opts = {}) {
  const rootDir = opts.rootDir || SERVER_ROOT;
  const playerDir = opts.playerDir || path.join(rootDir, 'public');
  const distDir = opts.distDir || path.join(rootDir, 'dist');
  const dataPath = path.join(playerDir, 'data.js');
  const streamsDir = path.join(playerDir, 'streams');
  const resolveSumo = opts.sumoResolver || findSumo;
  const maxBodyBytes = opts.maxBodyBytes || MAX_BODY_BYTES;
  const timeoutMs = opts.timeoutMs || SIMULATE_TIMEOUT_MS;
  const packRunJs = path.join(rootDir, 'tools', 'pack_run.js');
  const devInjectJs = path.join(rootDir, 'tools', 'dev_inject.js');

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
    });
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
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write('simo-player server -> http://127.0.0.1:' + port
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
