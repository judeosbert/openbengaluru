#!/usr/bin/env node
/* simo-player local server: static hosting + the submission/review API.
 *
 * POST /api/simulate runs the real pipeline (tools/pack_run.js as a
 * subprocess, then buildEntry IN-PROCESS) and persists everything to the
 * bucket + Postgres — the row stays `pending` and the public catalog
 * (GET /api/catalog) serves it only after an admin activates it. NO
 * player-dir writes, NO dev_inject subprocess, NO client reload: the
 * catalog has TWO sources (the read-only base bundle public/data.js +
 * active sims rows), merged client-side at boot.
 *
 *   node server.js            # PORT env overrides 8787
 *
 * Contract:
 *   POST /api/simulate  { id, title, author, desc, dataSource, sourceUrl?,
 *                         rouXml, todayNetXml, proposedNetXml?,
 *                         anchor?, rotation? }  (<= 25 MB)
 *     Authorization: Bearer <Firebase ID token> REQUIRED — verified via
 *     the opts.verifyToken seam (default: firebase-admin +
 *     GOOGLE_APPLICATION_CREDENTIALS) BEFORE the body is read; the body's
 *     author field is ignored — the DB/entry author comes from the verified
 *     claims (authorFromProfile: displayName -> email prefix -> uid) and
 *     ownership is keyed on claims.uid (author_uid).
 *   200 { id }                                   after the pipeline + finalize
 *   401 { error: 'authentication failed' }       missing/invalid/expired
 *                                                token (checked BEFORE body
 *                                                parsing/validation)
 *   400 { error }                                bad/missing fields
 *   403 { error }                                id belongs to another user
 *                                                (checked BEFORE any bucket
 *                                                mutation)
 *   413 { error }                                body over the cap
 *   422 { error: <stderr tail> }                 SUMO/pack failure
 *   500 { error: 'sumo binary not found …' }     SUMO undiscoverable
 *   500 { error: 'file storage failed …' }       bucket/DB persistence failed
 *   504 { error }                                tool timeout
 *
 * Review flow (plan: review flow + dashboards): submissions live OUTSIDE
 * data.js — Postgres (sims row + entry_json) + bucket (sources under
 * uploads/<id>/, review artifacts under uploads/<id>/review/). Statuses:
 * pending -> active | rejected; active -> inactive (superseded or pulled);
 * re-activation of inactive allowed. Admin identity: SIMO_ADMIN_EMAILS
 * (comma-separated, case-insensitive) checked against the verified token
 * claims.email; unset -> no admins (startup logs a warning).
 *   GET  /api/me                  (auth)  { author, email, uid, isAdmin }
 *   GET  /api/catalog             (PUBLIC) [entry_json…] of active rows
 *   GET  /api/catalog/:id/stream  (PUBLIC) stream payload JSON; active only
 *   GET  /api/submissions         (auth)  admin: all; user: own
 *   GET  /api/submissions/:id     (owner/admin) row + files + comments
 *   GET  /api/submissions/:id/preview   (owner/admin) { entry, stream }
 *   POST /api/submissions/:id/comments  {body} (owner/admin) -> 201 {id}
 *   POST /api/submissions/:id/activate  {supersedes?} (admin)
 *   POST /api/submissions/:id/reject    {comment}   (admin, pending)
 *   POST /api/submissions/:id/deactivate            (admin, active)
 *   400 bad input / 401 unauthenticated / 403 not owner or admin /
 *   404 unknown id / 409 bad state transition.
 *
 * Upload storage (bucket.js + db.js): after validateBody + the ownership
 * check the posted XMLs are PUT to the bucket under uploads/<id>/<name> and
 * referenced in Postgres; a re-put replaces ONLY metadata + file refs +
 * author fields (the review state is never touched by putUploadRefs). Files
 * are kept even when the simulation itself fails (422). The bucket stays
 * private: downloads are proxied by the server; creds never leave the
 * process.
 *   GET  /api/files/:id         -> 200 [names…] ([] for unknown-but-valid id)
 *   GET  /api/files/:id/:name   -> 200 <object bytes>; 404 when absent
 *   access: no sims row or status='active' -> public; otherwise
 *   owner-or-admin (401 unauthenticated, 403 foreign).
 *   400 { error }               invalid id / name (slug + no .., slashes or
 *                               leading dots — checked BEFORE any lookup)
 *   405 { error }               non-GET on the files API
 *
 * Area export (plan: area export + worker pool): POST /api/export-net
 * { bbox: [minLat,minLng,maxLat,maxLng], name?, zoom? } — Firebase auth
 * REQUIRED (the server becomes a shared OSM client; anonymous abuse would
 * burn its quota + CPU). The server fetches the OSM data, runs netconvert
 * (flags exactly as the retired convert.sh) in a worker-pool slot, and
 * answers ONE .zip holding BOTH files: the finished .net.xml (with
 * <!-- simo:zoom=N --> on line 2, auto-snap provenance for the Submit
 * wizard) and the fetched .osm.xml.
 *   200 application/zip attachment  "<name>.zip" (net + osm inside)
 *   401                         missing/invalid token (before body parse)
 *   400 { error }               bad bbox (shape/range/min<max/0.25° cap)
 *   400 { error }               OSM returned 400 (box too large upstream)
 *   422 { error: <stderr tail> } netconvert failure
 *   500 { error }               netconvert undiscoverable
 *   502 { error }               other OSM status / fetch failure
 *   503 { error }               pool busy | OSM 429/509 rate-limited
 *   504 { error }               netconvert timeout (SIMO_CONVERT_TIMEOUT_MS,
 *                               default 120 s)
 *
 * Email notifications (plan: email-notifications; mailer.js): plain-text
 * FIRE-AND-FORGET emails sent AFTER the HTTP response is written — a
 * failed send logs one stdout line and never changes the API response (no
 * retry/queue). Exactly three triggers, recipients = "the other party":
 *   comment posted  admin comment -> sims.author_email; owner comment ->
 *                   all SIMO_ADMIN_EMAILS; nobody is emailed about their
 *                   own comment; legacy rows (author_email null) skip.
 *   reject          the sim owner; the email carries the rejection comment
 *                   (the route's internal addComment does NOT double-send).
 *   activate WITH supersedes  only the SUPERSEDED sim's owner; plain or
 *                   idempotent activation sends nothing.
 * SMTP config: SIMO_SMTP_HOST/PORT/USER/PASS/FROM (+ optional
 * SIMO_SMTP_SECURE) or SIMO_SMTP_URL wholesale override (FROM always
 * required) — fail-fast at startup listing missing vars; the opts.mailer
 * seam swaps the whole mailer for tests. SIMO_PUBLIC_BASE_URL (optional)
 * appends a View link (the client has no deep links — Dashboard/Admin are
 * overlays).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createPool, runProcess } from './pool.js';
import { fileURLToPath } from 'node:url';
import { findSumo, findNetconvert, geoLock, sumoDataHome }
  from './tools/sumo_geom.js';
import * as dbStore from './db.js';
import * as bucketStore from './bucket.js';
import { buildEntry } from './tools/dev_inject.js';
import { createVerifyIdTokenFromEnv } from './verifyToken.js';
import { createMailerFromEnv, buildCommentEmail, buildRejectedEmail,
  buildSupersededEmail } from './mailer.js';
import { authorFromProfile } from './src/lib/profile.js';
import { DATA_SOURCES, validSourceUrl } from './src/lib/submit.js';
import { osmApiUrl, validateBbox, sanitizeAreaName }
  from './src/lib/areaExport.js';
import { buildZip } from './src/lib/zip.js';

const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));

export const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const SIMULATE_TIMEOUT_MS = 5 * 60 * 1000;
export const CONVERT_TIMEOUT_MS = 2 * 60 * 1000;

/* Pool sizing (plan: area export + worker pool): SIMO_WORKER_COUNT
 * (default cpus-1, min 1) slots, SIMO_WORKER_QUEUE_MAX (default 32) queued
 * submits. opts.workerCount / opts.queueMax are the injection seams. */
export function parsePoolConfig(env = process.env, opts = {}) {
  return {
    workers: opts.workerCount != null ? Number(opts.workerCount)
      : Number(env.SIMO_WORKER_COUNT) || Math.max(1, os.cpus().length - 1),
    queueMax: opts.queueMax != null ? Number(opts.queueMax)
      : Number(env.SIMO_WORKER_QUEUE_MAX) || 32,
  };
}

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

/* Default OSM client for POST /api/export-net (the opts.fetchOsm seam's
 * fallback). OSM blocks generic agents — send a descriptive one; hard
 * 60 s abort so a hung OSM API answers as 502, not a stuck socket. */
function defaultFetchOsm(bbox) {
  return fetch(osmApiUrl(bbox), {
    headers: { 'User-Agent': 'simo-player/area-export' },
    signal: AbortSignal.timeout(60_000),
  });
}

/* Download-name guard: reject '..', any slash, and leading dots BEFORE any
 * DB lookup or key use. Only the three fixed stored names can ever match a
 * sim_files row; this is the route-level 400 guard on top. */
function validName(name) {
  return typeof name === 'string' && name.length > 0
    && !name.startsWith('.')
    && !/[/\\]/.test(name);
}

export function validateBody(b) {
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
  /* mandatory data provenance (the wizard's DATA SOURCE field) */
  if (!DATA_SOURCES.includes(b.dataSource)) {
    return 'dataSource is required — one of: ' + DATA_SOURCES.join(', ');
  }
  const wantsUrl = b.dataSource === 'manual_survey'
    || b.dataSource === 'survey_data';
  if (wantsUrl) {
    if (!validSourceUrl(b.sourceUrl)) {
      return 'sourceUrl must be an http(s) URL for ' + b.dataSource;
    }
  } else if (b.sourceUrl != null && b.sourceUrl !== '') {
    return 'sourceUrl is only allowed for manual_survey/survey_data';
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
 * opts.storage): createSimServer({ db, bucket, verifyToken, adminEmails })
 * swaps the whole backend so tests can fail it or fake it. Defaults
 * construct from env and fail fast (createPoolFromEnv / createBucketFromEnv /
 * createVerifyIdTokenFromEnv list missing vars). */
function makeDbApi(pool) {
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

function makeBucketApi(s3) {
  return {
    putObjects: (id, files) => bucketStore.putObjects(s3, id, files),
    deleteObjects: (id) => bucketStore.deleteObjects(s3, id),
    getObjectBytes: (key) => bucketStore.getObjectBytes(s3, key),
    putReviewArtifacts: (id, arts) =>
      bucketStore.putReviewArtifacts(s3, id, arts),
    getReviewStream: (id) => bucketStore.getReviewStream(s3, id),
  };
}

/* Admin identity (plan: env-only, no user management UI): comma-separated,
 * case-insensitive; unset/empty -> no admins. Comparison key: the verified
 * claims.email lowercased + trimmed (a Firebase account without an email
 * claim is never admin). */
export function parseAdminEmails(env = process.env) {
  return String(env.SIMO_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/* Legal status values for the ?status= filter. */
const STATUSES = ['pending', 'active', 'rejected', 'inactive'];

/* Comment size cap (route-level; the DB CHECK guards non-empty). */
const MAX_COMMENT_CHARS = 4096;

/* Small JSON body reader for the review routes (NOT the 25 MB simulate
 * body): resolves the parsed object, or null on parse/size failure. */
function readJsonBody(req, cap = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { dead = true; resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => { if (!dead) { dead = true; resolve(null); } });
    req.on('end', () => {
      if (dead) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

export function createSimServer(opts = {}) {
  const rootDir = opts.rootDir || SERVER_ROOT;
  const playerDir = opts.playerDir || path.join(rootDir, 'public');
  const distDir = opts.distDir || path.join(rootDir, 'dist');
  const resolveSumo = opts.sumoResolver || findSumo;
  const maxBodyBytes = opts.maxBodyBytes || MAX_BODY_BYTES;
  const timeoutMs = opts.timeoutMs || SIMULATE_TIMEOUT_MS;
  /* DB backend: an injected opts.db (test seam) swaps everything — no
   * provisioning. The default env pool self-provisions at startup:
   * dbReady applies db/schema.sql (and creates the database if missing);
   * main() awaits it before listen. */
  let dbApi = opts.db || null;
  let dbReady = null;
  if (!dbApi) {
    const dbPool = dbStore.createPoolFromEnv();
    dbApi = makeDbApi(dbPool);
    dbReady = dbStore.ensureDbReady(dbPool, dbStore.pgConnFromEnv());
  }
  const bucketApi = opts.bucket
    || makeBucketApi(bucketStore.createBucketFromEnv());  const verifyToken = opts.verifyToken || createVerifyIdTokenFromEnv();
  const adminEmails = opts.adminEmails ?? parseAdminEmails(process.env);
  const mailer = opts.mailer || createMailerFromEnv();
  const packRunJs = path.join(rootDir, 'tools', 'pack_run.js');

  /* Fire-and-forget notification sender: called only AFTER sendJson has
   * written the response; a rejecting send logs one stdout line and never
   * touches the API outcome. */
  function notify(mail) {
    mailer.send(mail).catch((e) => process.stdout.write(
      'email notification failed: ' + String((e && e.message) || e) + '\n'));
  }

  /* Worker pool: async simulates run in bounded slots (never more than
   * `workers` SUMO pipelines at once) with a bounded FIFO queue — a full
   * queue answers 503 instead of holding sockets. opts.pool swaps the
   * whole pool for tests. (Review/catalog routes are pure async DB/bucket
   * work and need no pool.) */
  const pool = opts.pool || createPool(parsePoolConfig(process.env, opts));
  const resolveNetconvert = opts.netconvertResolver || findNetconvert;
  const fetchOsm = opts.fetchOsm || defaultFetchOsm;
  const convertTimeoutMs = opts.convertTimeoutMs
    || Number(process.env.SIMO_CONVERT_TIMEOUT_MS) || CONVERT_TIMEOUT_MS;

  /* Bearer-token verification — the one auth gate shared by simulate and
   * the review routes. Any failure (missing header, bad/expired token,
   * SDK error) maps to null; routes turn that into 401. */
  async function authClaims(req) {
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    try {
      return await verifyToken(m[1].trim());
    } catch {
      return null;
    }
  }

  function isAdmin(claims) {
    return !!claims && typeof claims.email === 'string'
      && adminEmails.includes(claims.email.trim().toLowerCase());
  }

  /* Owner-or-admin gate for row-scoped resources. Legacy rows (author_uid
   * null) are admin-only. */
  function ownOrAdmin(claims, row) {
    if (!claims) return false;
    if (isAdmin(claims)) return true;
    return !!row && row.author_uid === claims.uid;
  }

  function requireAuth(claims, res) {
    if (!claims) {
      sendJson(res, 401, { error: 'authentication failed' });
      return false;
    }
    return true;
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
      /* submit may throw (POOL_BUSY / closed pool) — normalize to a
       * rejected promise so one catch maps the outcome: POOL_BUSY -> 503,
       * anything else -> 500. */
      let run;
      try {
        run = pool.submit(() => processSimulate(req, res, chunks, respond));
      } catch (e) {
        run = Promise.reject(e);
      }
      run.catch((e) => {
        if (e && e.code === 'POOL_BUSY') {
          if (!res.headersSent) {
            sendJson(res, 503,
              { error: 'server busy — try again shortly' });
          }
        } else if (!res.headersSent) {
          sendJson(res, 500, { error: String((e && e.message) || e) });
        }
      });
    });
  }

  async function processSimulate(req, res, chunks, respond) {
    /* Auth FIRST — a 401 must not depend on body validity (invalid bodies
     * below), and verifying the ~1 KB token beats parsing a 25 MB body.
     * The raw SDK/verify error text never leaks into the response. */
    const claims = await authClaims(req);
    if (!claims) {
      return respond(401, { error: 'authentication failed' });
    }
    /* The verified claims are the author identity — the body's author
     * field is ignored (spoof-proof). authorFromProfile: displayName ->
     * email prefix -> uid; ownership keys on claims.uid. */
    const author = authorFromProfile(claims);
    const authorUid = claims.uid;
    const authorEmail = typeof claims.email === 'string'
      ? claims.email : null;

    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return respond(400, { error: 'invalid JSON body' });
    }
    const invalid = validateBody(body);
    if (invalid) return respond(400, { error: invalid });

    /* Ownership check BEFORE any bucket mutation: a foreign same-id POST
     * must never delete/replace the owner's stored sources. Legacy rows
     * (author_uid null) are admin-only. */
    let existing = null;
    try {
      existing = await dbApi.getSubmission(body.id);
    } catch (e) {
      return respond(500, { error: 'ownership check failed: '
        + String((e && e.message) || e) });
    }
    if (existing && !isAdmin(claims) && existing.author_uid !== claims.uid) {
      return respond(403, { error: 'this id already belongs to another '
        + 'submission' });
    }

    const sumo = resolveSumo();
    if (!sumo) {
      return respond(500, { error: 'sumo binary not found — install '
        + 'SUMO (https://sumo.dlr.de/docs/Installing.html) or set '
        + 'SUMO_HOME' });
    }

    /* persist the uploaded sources AFTER validation + the ownership check,
     * BEFORE the pipeline: a bucket/DB failure -> 500 and the review
     * finalize never runs, so the catalog stays untouched. Files are kept
     * even when the simulation itself fails (422) — the sources are the
     * user's data, the tempdir is not. A re-put deletes the superseded
     * bucket objects best-effort first (log, don't fail). putUploadRefs
     * replaces metadata + refs + author fields ONLY — the review state
     * survives (uploads survive even a 422). */
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
      await dbApi.putUploadRefs(body.id,
        { ...body, author, authorUid, authorEmail }, refs);
    } catch (e) {
      return respond(500, { error: 'file storage failed: '
        + String((e && e.message) || e) });
    }

    /* per-request tempdir for the SUMO inputs; cleaned on every exit path.
     * pack_run is the only subprocess — the catalog entry + review stream
     * are built IN-PROCESS via buildEntry (the pure extraction the CLI
     * also uses) and persisted to the bucket + DB by finalizeSim. No
     * player-dir writes anywhere. */
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

      const pr = await runProcess(process.execPath,
        [packRunJs, ...scenArgs, '-o', packOut, '--sumo', sumo],
        { timeoutMs });
      if (pr.signal) {
        return respond(504, { error: 'simulation timed out' });
      }
      if (pr.status !== 0) {
        return respond(422,
          { error: tail(pr.stderr) || 'pack_run exited ' + pr.status });
      }

      /* build the catalog entry + review stream in-process. The pack is
       * the pipeline's output; the net's geo provenance feeds the fallback
       * placement path exactly like the CLI's --net flag. */
      const pack = JSON.parse(fs.readFileSync(packOut, 'utf8'));
      const netGeo = geoLock(todayNet);
      const { entry, streamPayload } = buildEntry(pack, {
        title: body.title,
        author,
        id: body.id,
        desc: body.desc,
        anchor: body.anchor,
        rotation: body.rotation,
        dataSource: body.dataSource,
        sourceUrl: body.sourceUrl,
        netGeo,
      });
      try {
        /* review artifacts: pack (write-only provenance) + the playable
         * stream payload, then the finalize (entry_json + sim_ready +
         * review-state reset). Both failures -> 500; the row stays pending
         * + !sim_ready so a resubmit retries cleanly. */
        await bucketApi.putReviewArtifacts(body.id, { pack, stream: streamPayload });
        await dbApi.finalizeSim(body.id, {
          entryJson: entry,
          demand: entry.demand,
          peakServed: entry.peakServed,
          hasProposed: !!body.proposedNetXml,
        });
      } catch (e) {
        return respond(500, { error: 'file storage failed: '
          + String((e && e.message) || e) });
      }
      /* resubmission marker: a re-pipeline of an existing row stamps the
       * review thread so reviewers see the resubmit in context. Best-effort
       * — the submission itself already finalized; a comment failure must
       * not turn the 200 into an error (the client would fall back to a
       * geometry-only preview for a row that is actually fine). */
      if (existing) {
        try {
          await dbApi.addComment(body.id, {
            author: 'system',
            authorUid: 'system',
            isAdmin: false,
            body: 'resubmitted — back to pending review',
          });
        } catch (e) {
          process.stdout.write('resubmit comment skipped: '
            + String((e && e.message) || e) + '\n');
        }
      }
      return respond(200, { id: body.id });
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  }

  /* POST /api/export-net — authenticated server-side area export: fetch
   * the OSM data for a bbox, run netconvert (same flags as the retired
   * convert.sh) in a pool slot, answer ONE .zip holding the finished
   * .net.xml + the fetched .osm.xml. Auth-first like simulate; no
   * DB/bucket involvement. */
  async function handleExportNet(req, res) {
    const started = Date.now();
    const log = (status, err) => {
      process.stdout.write(`POST /api/export-net -> ${status} `
        + `${((Date.now() - started) / 1000).toFixed(1)}s`
        + (err ? ' — ' + String(err).split('\n')[0].slice(0, 200) : '')
        + '\n');
    };
    const respond = (status, body) => {
      log(status, status >= 400 ? body.error : null);
      sendJson(res, status, body);
    };
    const claims = await authClaims(req);
    if (!claims) {
      return respond(401, { error: 'authentication failed' });
    }
    const body = await readJsonBody(req);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return respond(400, { error: 'JSON object body required' });
    }
    const bboxErr = validateBbox(body.bbox);
    if (bboxErr) return respond(400, { error: bboxErr });
    const name = sanitizeAreaName(typeof body.name === 'string'
      ? body.name : '');
    let zoom = body.zoom == null ? null : Math.round(Number(body.zoom));
    if (zoom != null && !Number.isFinite(zoom)) zoom = null;
    if (zoom != null) zoom = Math.min(19, Math.max(3, zoom));

    const netconvert = resolveNetconvert();
    if (!netconvert) {
      return respond(500, { error: 'netconvert not found — install SUMO '
        + '(https://sumo.dlr.de/docs/Installing.html) or set SUMO_HOME' });
    }

    let xml;
    try {
      const r = await fetchOsm(body.bbox);
      if (r.status === 200) {
        xml = await r.text();
      } else if (r.status === 400) {
        return respond(400, { error: 'box too large for the OSM API — '
          + 'draw a smaller area' });
      } else if (r.status === 429 || r.status === 509) {
        return respond(503, { error: 'OSM rate-limited — try again in '
          + 'a minute' });
      } else {
        return respond(502,
          { error: 'OSM API error (HTTP ' + r.status + ')' });
      }
    } catch (e) {
      return respond(502, { error: 'OSM fetch failed: '
        + String((e && e.message) || e) });
    }

    /* stamp the requested zoom as a comment (the same two regexes the
     * client used to stamp before convert.sh ran; netconvert strips
     * comments, so step 2 below carries it into the NET file too) */
    if (zoom != null) {
      const tag = '<!-- simo:zoom=' + zoom + ' -->';
      if (/<bounds\b[^>]*\/>/.test(xml)) {
        xml = xml.replace(/(<bounds\b[^>]*\/>)/, '$1\n' + tag);
      } else if (/<\/osm>/.test(xml)) {
        xml = xml.replace(/<\/osm>/, tag + '\n</osm>');
      }
    }

    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-export-'));
    try {
      const osmPath = path.join(td, name + '.osm.xml');
      const netPath = path.join(td, name + '.net.xml');
      fs.writeFileSync(osmPath, xml);
      /* netconvert runs in a pool slot (CPU-bound subprocess, bounded
       * like simulate). POOL_BUSY -> 503, same body. The env derives
       * SUMO_HOME from the discovered binary so the default OSM typemap
       * resolves on every layout (macOS Eclipse framework splits bin/
       * from data/); null -> inherit untouched. */
      const ncEnv = (() => {
        const home = sumoDataHome(netconvert);
        return home ? { ...process.env, SUMO_HOME: home } : undefined;
      })();
      let run;
      try {
        run = pool.submit(() => runProcess(netconvert, [
          '--osm-files', osmPath,
          '--output-file', netPath,
          '--geometry.remove',
          '--junctions.join',
          '--roundabouts.guess',
          '--tls.guess',
          '--tls.join',
          '--junctions.corner-detail', '5',
        ], { timeoutMs: convertTimeoutMs, env: ncEnv }));
      } catch (e) {
        run = Promise.reject(e);
      }
      let pr;
      try {
        pr = await run;
      } catch (e) {
        if (e && e.code === 'POOL_BUSY') {
          return respond(503, { error: 'server busy — try again shortly' });
        }
        return respond(500, { error: String((e && e.message) || e) });
      }
      if (pr.signal) {
        return respond(504, { error: 'netconvert timed out' });
      }
      if (pr.status !== 0) {
        return respond(422, {
          error: tail(pr.stderr) || 'netconvert exited ' + pr.status,
        });
      }
      /* carry the zoom comment into the net: insert as line 2 (the
       * convert.sh awk step, as a string op) — parseNetXml reads it back
       * as suggestedZoom for the auto-snap */
      let net = fs.readFileSync(netPath, 'utf8');
      if (zoom != null) {
        const tag = '<!-- simo:zoom=' + zoom + ' -->';
        const nl = net.indexOf('\n');
        net = nl === -1 ? net + '\n' + tag
          : net.slice(0, nl + 1) + tag + net.slice(nl);
      }
      /* ONE zip, both artifacts: the finished net (zoom stamp on line 2)
       * + the SAME fetched OSM the conversion consumed (zoom-stamped). */
      const zip = buildZip([
        { name: name + '.net.xml', body: net },
        { name: name + '.osm.xml', body: xml },
      ]);
      log(200, null);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + name + '.zip"',
      });
      res.end(zip);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  }

  /* GET /api/files/:id [/:name] — listing and download of the stored
   * uploads. Segments are decoded and validated per-segment (URL %2F tricks
   * never reach a key or a DB query). One indexed status SELECT gates
   * access: no sims row (generated/unknown ids) or an active row -> public
   * (SimPanel's unauthenticated fetch keeps working); otherwise
   * owner-or-admin. One log line per request, matching simulate. */
  async function handleFiles(pathname, res, req) {
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
    /* access rule: one status SELECT before any listing/download work */
    let row = null;
    try {
      row = await dbApi.getSubmission(id);
    } catch (e) {
      return respond(500, null, { error: String((e && e.message) || e) });
    }
    if (row && row.status !== 'active') {
      const claims = await authClaims(req);
      if (!claims) {
        return respond(401, null, { error: 'authentication failed' });
      }
      if (!ownOrAdmin(claims, row)) {
        return respond(403, null,
          { error: 'not your submission' });
      }
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

  /* GET /api/me — the client's role discovery: { author, email, uid,
   * isAdmin }. isAdmin comes from the verified claims.email vs
   * SIMO_ADMIN_EMAILS; no email claim -> never admin. */
  async function handleMe(req, res) {
    const claims = await authClaims(req);
    if (!requireAuth(claims, res)) return;
    sendJson(res, 200, {
      author: authorFromProfile(claims),
      email: typeof claims.email === 'string' ? claims.email : null,
      uid: claims.uid,
      isAdmin: isAdmin(claims),
    });
  }

  /* GET /api/catalog — PUBLIC: the active submissions half of the
   * two-source catalog. Generated base-bundle entries never appear here
   * (no sims rows). */
  async function handleCatalog(res) {
    try {
      const rows = await dbApi.listActiveEntries();
      return sendJson(res, 200, rows.map((r) => r.entry));
    } catch (e) {
      return sendJson(res, 500,
        { error: String((e && e.message) || e) });
    }
  }

  /* GET /api/catalog/:id/stream — PUBLIC lazy-stream source for
   * API-catalog entries (JSON fetch, not JSONP): 404 unless the row exists
   * AND is active AND the bucket object is present. */
  async function handleCatalogStream(pathname, res) {
    const segs = pathname.split('/').filter(Boolean).slice(2);
    const decode = (s) => {
      try { return decodeURIComponent(s); } catch { return null; }
    };
    const id = segs.length ? decode(segs[0]) : null;
    if (typeof id !== 'string' || !bucketStore.ID_RE.test(id)) {
      return sendJson(res, 400, { error: 'invalid id' });
    }
    let row = null;
    try {
      row = await dbApi.getSubmission(id);
    } catch (e) {
      return sendJson(res, 500, { error: String((e && e.message) || e) });
    }
    if (!row || row.status !== 'active') {
      return sendJson(res, 404, { error: 'not found' });
    }
    let stream = null;
    try {
      stream = await bucketApi.getReviewStream(id);
    } catch (e) {
      return sendJson(res, 500, { error: String((e && e.message) || e) });
    }
    if (!stream) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stream));
  }

  /* Shared prologue for the /api/submissions/:id[/:action] routes:
   * decodes + validates the id, loads the row, applies the owner-or-admin
   * gate (need !== undefined) or leaves the row for the admin-only action
   * checks. Returns { id, row, claims } or has already responded. */
  async function loadSubmission(pathname, req, res, need) {
    const segs = pathname.split('/').filter(Boolean).slice(2);
    const decode = (s) => {
      try { return decodeURIComponent(s); } catch { return null; }
    };
    const id = segs.length ? decode(segs[0]) : null;
    if (typeof id !== 'string' || !bucketStore.ID_RE.test(id)) {
      sendJson(res, 400, { error: 'invalid id' });
      return null;
    }
    const claims = await authClaims(req);
    if (!requireAuth(claims, res)) return null;
    let row = null;
    try {
      row = await dbApi.getSubmission(id);
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) });
      return null;
    }
    if (!row) {
      sendJson(res, 404, { error: 'not found: ' + id });
      return null;
    }
    if (need && !ownOrAdmin(claims, row)) {
      sendJson(res, 403, { error: 'not your submission' });
      return null;
    }
    return { id, row, claims };
  }

  async function handleSubmissions(pathname, req, res, u) {
    if (pathname === '/api/submissions') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      const claims = await authClaims(req);
      if (!requireAuth(claims, res)) return;
      const status = u.searchParams.get('status');
      if (status != null && !STATUSES.includes(status)) {
        return sendJson(res, 400, { error: 'invalid status filter' });
      }
      const filter = {};
      if (!isAdmin(claims)) filter.authorUid = claims.uid;
      if (status) filter.status = status;
      try {
        const rows = await dbApi.listSubmissions(filter);
        return sendJson(res, 200, rows);
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
    }

    const segs = pathname.split('/').filter(Boolean).slice(2);
    if (segs.length === 0) {
      return sendJson(res, 400, { error: 'id required' });
    }
    if (segs.length > 2) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const action = segs[1] != null
      ? (decodeURIComponent(segs[1])) : null;
    const ACTIONS = ['preview', 'comments', 'activate', 'reject',
      'deactivate'];
    if (action !== null && !ACTIONS.includes(action)) {
      return sendJson(res, 404, { error: 'not found' });
    }

    /* detail + preview + comments are owner-or-admin; the review actions
     * are admin-only (admin check runs after the row loads). */
    const ctx = await loadSubmission(pathname, req, res,
      action === 'activate' || action === 'reject'
        || action === 'deactivate' ? false : true);
    if (!ctx) return;
    const { id, row, claims } = ctx;

    if (!action) {
      /* GET detail: row + files list + comment thread */
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      try {
        const files = await dbApi.listUploads(id);
        const comments = await dbApi.listComments(id);
        return sendJson(res, 200, { submission: row, files, comments });
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
    }
    if (action === 'preview') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      if (!row.sim_ready || row.entry_json == null) {
        return sendJson(res, 404, { error: 'not found' });
      }
      let stream = null;
      try {
        stream = await bucketApi.getReviewStream(id);
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      if (!stream) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, { entry: row.entry_json, stream });
    }
    if (action === 'comments') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      const body = await readJsonBody(req);
      const text = body && typeof body.body === 'string'
        ? body.body.trim() : '';
      if (!text) return sendJson(res, 400, { error: 'body is required' });
      if (text.length > MAX_COMMENT_CHARS) {
        return sendJson(res, 400,
          { error: 'body too long (max ' + MAX_COMMENT_CHARS + ' chars)' });
      }
      /* is_admin is stamped server-side from the verified claims — the
       * request can never claim admin */
      const admin = isAdmin(claims);
      try {
        const c = await dbApi.addComment(id, {
          author: authorFromProfile(claims),
          authorUid: claims.uid,
          isAdmin: admin,
          body: text,
        });
        /* notification = "the other party": admin comment -> the sim
         * owner, owner comment -> all admins. The self-comment skip only
         * covers the direction where the sender IS the recipient (admin
         * commenting on their own sim) — an owner replying on their own
         * sim still notifies the admins. Legacy rows (author_email null)
         * have no owner address on the admin direction. */
        const recipients = admin
          ? (row.author_email ? [row.author_email] : [])
          : adminEmails;
        sendJson(res, 201, c);
        if (recipients.length
            && !(admin && row.author_uid === claims.uid)) {
          notify({ to: recipients, ...buildCommentEmail({
            sim: row, comment: text, byAdmin: admin,
            baseUrl: mailer.baseUrl }) });
        }
        return;
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
    }

    /* --------------------------- admin-only review actions from here */
    if (!isAdmin(claims)) {
      return sendJson(res, 403, { error: 'admin only' });
    }
    const reviewedBy = claims.uid;

    if (action === 'activate') {
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      if (body === null) {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      const supersedes = body && body.supersedes != null
        ? String(body.supersedes) : null;
      if (supersedes != null
          && (supersedes === id || !bucketStore.ID_RE.test(supersedes))) {
        return sendJson(res, 400, { error: 'invalid supersedes target' });
      }
      if (!row.sim_ready || row.entry_json == null) {
        return sendJson(res, 409, { error: 'submission is not reviewable '
          + '— no successful pipeline artifacts' });
      }
      if (row.status === 'active' && !supersedes) {
        /* idempotent retry */
        return sendJson(res, 200, { id, status: 'active',
          supersedes: null });
      }
      if (row.status === 'active' && supersedes) {
        return sendJson(res, 409, { error: 'already active — deactivate '
          + 'or activate without supersedes' });
      }
      if (row.status === 'rejected') {
        return sendJson(res, 409,
          { error: 'rejected submissions cannot be activated' });
      }
      let supersededRow = null;
      if (supersedes != null) {
        let target = null;
        try {
          target = await dbApi.getSubmission(supersedes);
        } catch (e) {
          return sendJson(res, 500,
            { error: String((e && e.message) || e) });
        }
        if (!target || target.status !== 'active') {
          return sendJson(res, 409,
            { error: 'supersedes target is not active' });
        }
        supersededRow = target;
      }
      /* the playable stream must exist — activating without one would
       * publish a catalog entry whose frames 404 */
      let stream = null;
      try {
        stream = await bucketApi.getReviewStream(id);
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      if (!stream) {
        return sendJson(res, 409, { error: 'stream artifact missing' });
      }
      try {
        await dbApi.activateTx(id, { reviewedBy, supersedes });
      } catch (e) {
        return sendJson(res, 409,
          { error: String((e && e.message) || e) });
      }
      sendJson(res, 200, { id, status: 'active', supersedes });
      /* only the SUPERSEDED sim's owner is emailed (plain/idempotent
       * activation sends nothing); legacy targets (author_email null) skip */
      if (supersededRow && supersededRow.author_email) {
        notify({ to: [supersededRow.author_email],
          ...buildSupersededEmail({ sim: supersededRow,
            by: { id, title: row.title }, baseUrl: mailer.baseUrl }) });
      }
      return;
    }

    if (action === 'reject') {
      const body = await readJsonBody(req);
      const comment = body && typeof body.comment === 'string'
        ? body.comment.trim() : '';
      if (!comment) {
        return sendJson(res, 400,
          { error: 'comment is required to reject' });
      }
      if (row.status !== 'pending') {
        return sendJson(res, 409,
          { error: 'only pending submissions can be rejected' });
      }
      try {
        await dbApi.setStatus(id, { status: 'rejected', reviewedBy });
        await dbApi.addComment(id, {
          author: authorFromProfile(claims),
          authorUid: claims.uid,
          isAdmin: true,
          body: comment,
        });
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      sendJson(res, 200, { id, status: 'rejected' });
      /* the owner is emailed the rejection comment; the addComment above
       * must NOT trigger a second "new comment" email (notification
       * triggers live in the routes, never in dbApi.addComment) */
      if (row.author_email) {
        notify({ to: [row.author_email], ...buildRejectedEmail({
          sim: row, comment, baseUrl: mailer.baseUrl }) });
      }
      return;
    }

    /* deactivate */
    if (row.status !== 'active') {
      return sendJson(res, 409,
        { error: 'only active submissions can be deactivated' });
    }
    try {
      await dbApi.setStatus(id, { status: 'inactive', reviewedBy });
    } catch (e) {
      return sendJson(res, 500, { error: String((e && e.message) || e) });
    }
    return sendJson(res, 200, { id, status: 'inactive' });
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && u.pathname === '/api/simulate') {
      try {
        handleSimulate(req, res);
      } catch (e) {
        sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/export-net') {
      handleExportNet(req, res).catch((e) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: String((e && e.message) || e) });
        }
      });
      return;
    }
    if (u.pathname === '/api/me') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      handleMe(req, res).catch((e) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: String((e && e.message) || e) });
        }
      });
      return;
    }
    if (u.pathname === '/api/catalog') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      handleCatalog(res);
      return;
    }
    if (u.pathname.startsWith('/api/catalog/')) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      handleCatalogStream(u.pathname, res).catch((e) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: String((e && e.message) || e) });
        }
      });
      return;
    }
    if (u.pathname === '/api/submissions'
        || u.pathname.startsWith('/api/submissions/')) {
      handleSubmissions(u.pathname, req, res, u).catch((e) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: String((e && e.message) || e) });
        }
      });
      return;
    }
    if (u.pathname === '/api/files' || u.pathname.startsWith('/api/files/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      handleFiles(u.pathname, res, req).catch((e) => {
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
  /* close the pool with the server so tests (and shutdown) don't leak
   * in-flight jobs — close() drains, it does not kill. */
  const origClose = server.close.bind(server);
  server.close = (cb) => {
    try { pool.close(); } catch { /* already closed */ }
    return origClose(cb);
  };
  /* startup DB provisioning promise (null when opts.db is injected) —
   * main() awaits it before listen; tests may too. */
  server.dbReady = dbReady;
  return server;
}

export async function main() {
  const port = Number(process.env.PORT) || 8787;
  if (!parseAdminEmails().length) {
    process.stdout.write('warning: SIMO_ADMIN_EMAILS unset/empty — no '
      + 'admins exist; submissions stay pending and the review UI is '
      + 'hidden (set it to activate sims)\n');
  }
  const pc = parsePoolConfig();
  process.stdout.write(`worker pool: ${pc.workers} slots `
    + '(SIMO_WORKER_COUNT), queue cap ' + pc.queueMax + '\n');
  const server = createSimServer();
  if (server.dbReady) {
    try {
      await server.dbReady;
      process.stdout.write('database ready — schema ensured\n');
    } catch (e) {
      process.stderr.write('database startup failed: '
        + String((e && e.message) || e) + '\n');
      process.exit(1);
      return;
    }
  }
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
  main().catch((e) => {
    process.stderr.write('server startup failed: '
      + String((e && e.message) || e) + '\n');
    process.exit(1);
  });
}