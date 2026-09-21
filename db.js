/* Postgres system of record for wizard submissions: sim metadata (sims) +
 * references to the bucket objects holding the uploaded XMLs (sim_files).
 * Server-side module — repo root, NOT src/lib (that layer must stay
 * DOM-free; this one is deliberately db-heavy). The DB never stores file
 * content — only object key, url and size (bucket.js holds the bytes).
 *
 * Env shape: discrete PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE with NO
 * code defaults — createPoolFromEnv fails fast listing missing vars.
 * DATABASE_URL or SIMO_DATABASE_URL overrides wholesale when set. The
 * password is never logged.
 *
 * Every query here is parameterized ($1…) — zero string interpolation of
 * caller data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const PG_VARS = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD',
  'PGDATABASE'];

/* Connection options from env — the fail-fast missing-vars contract lives
 * here so every consumer (server, db_setup) shares one source of truth. */
export function pgConnFromEnv(env = process.env) {
  const url = env.DATABASE_URL || env.SIMO_DATABASE_URL;
  if (url) return { connectionString: url };
  const missing = PG_VARS.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error('missing env: ' + missing.join(', ')
      + ' — set the PG* vars (see .env.example) or DATABASE_URL');
  }
  return {
    host: env.PGHOST,
    port: Number(env.PGPORT),
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: env.PGDATABASE,
  };
}

export function createPoolFromEnv(env = process.env) {
  return new pg.Pool(pgConnFromEnv(env));
}

/* putUploadRefs: replace-on-resimulate in ONE transaction — upsert the
 * sims row (every metadata column takes the new body's value, matching the
 * catalog's replace-on-resimulate) + delete this sim's sim_files rows +
 * insert the new refs. The refs arrive from bucket.js putObjects; object
 * keys/urls/sizes are stored verbatim. The body additionally carries the
 * verified author identity (authorUid/authorEmail — the server supplies
 * them from the token claims; ownership is by author_uid, never the
 * display name). Resolves to the sorted stored names. Any failure rolls
 * the whole put back (the sims upsert included).
 *
 * On conflict the update touches ONLY metadata + author fields (the review
 * state — status/sim_ready/entry_json/review columns — is deliberately
 * NOT in the update list): a re-pipeline that dies before finalizeSim
 * changes nothing but the stored sources, mirroring the "uploads survive
 * even a 422" contract. A fresh insert leaves the review columns at the
 * schema defaults (status 'pending', sim_ready false, entry_json null). */
export async function putUploadRefs(pool, id, body, refs) {
  const b = body || {};
  const rows = refs || [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      'insert into sims (id, title, author, description, data_source,'
      + ' source_url, anchor_lat, anchor_lng, rotation, author_uid,'
      + ' author_email)'
      + ' values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)'
      + ' on conflict (id) do update set'
      + ' title = excluded.title,'
      + ' author = excluded.author,'
      + ' description = excluded.description,'
      + ' data_source = excluded.data_source,'
      + ' source_url = excluded.source_url,'
      + ' anchor_lat = excluded.anchor_lat,'
      + ' anchor_lng = excluded.anchor_lng,'
      + ' rotation = excluded.rotation,'
      + ' author_uid = excluded.author_uid,'
      + ' author_email = excluded.author_email,'
      + ' updated_at = now()',
      [id, b.title, b.author ?? null, b.desc ?? null,
        b.dataSource ?? null, b.sourceUrl ?? null,
        b.anchor?.[0] ?? null, b.anchor?.[1] ?? null, b.rotation ?? null,
        b.authorUid ?? null, b.authorEmail ?? null]);
    await client.query('delete from sim_files where sim_id = $1', [id]);
    for (const r of rows) {
      await client.query(
        'insert into sim_files (sim_id, name, object_key, object_url,'
        + ' size_bytes) values ($1, $2, $3, $4, $5)',
        [id, r.name, r.object_key, r.object_url, r.size_bytes]);
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return rows.map((r) => r.name).sort();
}

/* listUploads: sorted stored names for an id; [] when the id has no uploads
 * (unknown-but-valid ids are an empty list, not an error). */
export async function listUploads(pool, id) {
  const r = await pool.query(
    'select name from sim_files where sim_id = $1 order by name', [id]);
  return r.rows.map((row) => row.name);
}

/* getUploadRef: { name, object_key, object_url, size_bytes } or null when
 * absent (route maps that to 404). size_bytes comes back as a number — pg
 * returns int8 as a string, which would poison Content-Length math. */
export async function getUploadRef(pool, id, name) {
  const r = await pool.query(
    'select name, object_key, object_url, size_bytes'
    + ' from sim_files where sim_id = $1 and name = $2',
    [id, name]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    name: row.name,
    object_key: row.object_key,
    object_url: row.object_url,
    size_bytes: Number(row.size_bytes),
  };
}

export function closePool(pool) {
  return pool && typeof pool.end === 'function' ? pool.end()
    : Promise.resolve();
}

/* ------------------------------------------------ startup provisioning */

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = fs.readFileSync(
  path.join(ROOT, 'db', 'schema.sql'), 'utf8');

const DB_NAME_RE = /^[a-z0-9_]+$/;

/* maintenanceConn: connection options for a maintenance database, derived
 * from the target's connOpts — DATABASE_URL rewrites the path, discrete
 * PG* overrides the database (same shape tools/db_setup.js connFor uses).
 * The name is the one dynamic identifier: validated + double-quoted. */
function maintenanceConn(connOpts, name) {
  if (!DB_NAME_RE.test(name)) {
    throw new Error('invalid maintenance db name: ' + JSON.stringify(name));
  }
  if (connOpts.connectionString) {
    const u = new URL(connOpts.connectionString);
    u.pathname = '/' + name;
    return { connectionString: u.toString() };
  }
  return { ...connOpts, database: name };
}

/* targetDbName: the database the connOpts point at (URL path or the
 * discrete database field). */
function targetDbName(connOpts) {
  if (connOpts.connectionString) {
    const name = decodeURIComponent(
      new URL(connOpts.connectionString).pathname.replace(/^\//, ''));
    if (!name) {
      throw new Error('connection string carries no database name');
    }
    return name;
  }
  return connOpts.database;
}

/* applySchema: idempotent DDL from db/schema.sql in ONE transaction on a
 * single client (the same shape tools/db_setup.js uses — the file carries
 * no transaction statements of its own). Internal: ensureDbReady is the
 * startup entry point. */
async function applySchema(pool) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(SCHEMA_SQL);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* ensureDbReady: the server's startup provisioning — a fresh database
 * (e.g. a newly provisioned Railway Postgres) needs no manual
 * npm run db:setup. Contract: connect; if the target database does not
 * exist (SQLSTATE 3D000) create it via a maintenance connection (default
 * 'postgres', opts.maintenanceDb overrides) and reconnect; then apply
 * db/schema.sql idempotently in one transaction. Any other failure
 * (unreachable host, auth, DDL permission) propagates — the caller (main)
 * exits non-zero so the platform restarts. The pool arrives from the
 * server (createPoolFromEnv); connOpts is the same shape, needed only to
 * derive the maintenance connection and target name. */
export async function ensureDbReady(pool, connOpts, opts = {}) {
  const maintenance = opts.maintenanceDb || 'postgres';
  try {
    await pool.query('select 1');
  } catch (e) {
    if ((e && e.code) !== '3D000') throw e;
    const name = targetDbName(connOpts);
    if (!DB_NAME_RE.test(name)) {
      throw new Error('target database name must match ^[a-z0-9_]+$, got: '
        + JSON.stringify(name));
    }
    const admin = new pg.Pool(maintenanceConn(connOpts, maintenance));
    try {
      await admin.query('create database "' + name + '"');
    } finally {
      await admin.end();
    }
    await pool.query('select 1');
  }
  await applySchema(pool);
}

/* ------------------------------------------------------------ review flow */

/* finalizeSim: called by the server after a successful pipeline — the row
 * becomes reviewable. Sets the catalog entry + the dashboard list columns,
 * flips sim_ready on, and RESETS the review state: status back to 'pending'
 * (a re-pipeline of an active/rejected sim re-enters the queue), reviewed
 * fields and superseded_by cleared. The comment thread is preserved (same
 * row). */
export async function finalizeSim(pool, id,
  { entryJson, demand, peakServed, hasProposed }) {
  const r = await pool.query(
    'update sims set entry_json = $2, sim_ready = true, status = \'pending\','
    + ' reviewed_by = null, reviewed_at = null, superseded_by = null,'
    + ' demand = $3, peak_served = $4, has_proposed = $5, updated_at = now()'
    + ' where id = $1',
    [id, entryJson ?? null, demand ?? null, peakServed ?? null,
      hasProposed ?? false]);
  return r.rowCount === 1;
}

/* listSubmissions: dashboard list rows. Admin (no authorUid) sees all;
 * a non-admin passes their authorUid. Optional status filter. Each row
 * carries a LEFT-JOIN comment_count. Ordering: pending rows first (the
 * review queue), then created_at desc. pg returns int8 as string —
 * comment_count is normalized to a number. entry_json is excluded (the
 * list wants the small columns; the entry rides on getSubmission). */
const SUBMISSION_COLS
  = 's.id, s.title, s.author, s.description, s.data_source, s.source_url,'
  + ' s.anchor_lat, s.anchor_lng,'
  + ' s.rotation, s.status, s.author_uid, s.author_email, s.reviewed_by,'
  + ' s.reviewed_at, s.superseded_by, s.demand, s.peak_served,'
  + ' s.has_proposed, s.sim_ready, s.created_at, s.updated_at,'
  + ' (select count(*) from review_comments c where c.sim_id = s.id)'
  + '   as comment_count';

export async function listSubmissions(pool, filter = {}) {
  const where = [];
  const params = [];
  if (filter.authorUid) {
    params.push(filter.authorUid);
    where.push('s.author_uid = $' + params.length);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push('s.status = $' + params.length);
  }
  const sql = 'select ' + SUBMISSION_COLS + ' from sims s'
    + (where.length ? ' where ' + where.join(' and ') : '')
    + " order by (s.status = 'pending') desc, s.created_at desc";
  const r = await pool.query(sql, params);
  return r.rows.map((row) => ({ ...row,
    comment_count: Number(row.comment_count) }));
}

/* getSubmission: the full sims row (entry_json included) or null. */
export async function getSubmission(pool, id) {
  const r = await pool.query('select * from sims where id = $1', [id]);
  return r.rows.length ? r.rows[0] : null;
}

/* listActiveEntries: [{id, entry}] — the public catalog payload source
 * (GET /api/catalog). Only active rows with a built entry; generated base
 * bundle entries never appear here (no sims rows). */
export async function listActiveEntries(pool) {
  const r = await pool.query(
    "select id, entry_json from sims"
    + " where status = 'active' and entry_json is not null"
    + ' order by created_at');
  return r.rows.map((row) => ({ id: row.id, entry: row.entry_json }));
}

/* listComments: the thread for one sim, oldest first. */
export async function listComments(pool, simId) {
  const r = await pool.query(
    'select id, author, author_uid, is_admin, body, created_at'
    + ' from review_comments where sim_id = $1 order by created_at, id',
    [simId]);
  return r.rows.map((c) => ({ ...c, id: Number(c.id) }));
}

/* addComment: insert one thread row (is_admin stamped server-side from
 * the verified claims, never taken from the body). The DB CHECK keeps the
 * body non-empty after trim; the route trims and caps size. Returns the
 * inserted row's numeric id (BIGSERIAL comes back as int8 -> string). */
export async function addComment(pool, simId,
  { author, authorUid, isAdmin, body }) {
  const r = await pool.query(
    'insert into review_comments (sim_id, author, author_uid, is_admin,'
    + ' body) values ($1, $2, $3, $4, $5) returning id',
    [simId, author, authorUid, !!isAdmin, body]);
  return { id: Number(r.rows[0].id) };
}

/* setStatus: the reject/deactivate transition — flips status and stamps
 * the reviewing admin + time. App-level transition rules live in the
 * server; this is the write. */
export async function setStatus(pool, id, { status, reviewedBy }) {
  const r = await pool.query(
    'update sims set status = $2, reviewed_by = $3, reviewed_at = now(),'
    + ' updated_at = now() where id = $1',
    [id, status, reviewedBy ?? null]);
  return r.rowCount === 1;
}

/* activateTx: the activation transaction — ONE tx so the supersede pair
 * is atomic. This sim -> active (+reviewed_by/at, superseded_by=null);
 * when supersedes is given, that target -> 'inactive' with
 * superseded_by = <this id> ("which entry superseded this one" lives on
 * the deactivated row). The supersede UPDATE carries a status='active'
 * guard so a target flipped between the route check and this tx makes the
 * whole tx throw (nothing activates on a lost race). */
export async function activateTx(pool, id, { reviewedBy, supersedes }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      'update sims set status = \'active\', reviewed_by = $2,'
      + ' reviewed_at = now(), superseded_by = null, updated_at = now()'
      + ' where id = $1',
      [id, reviewedBy ?? null]);
    if (supersedes != null) {
      const r = await client.query(
        "update sims set status = 'inactive', reviewed_by = $2,"
        + ' reviewed_at = now(), superseded_by = $3, updated_at = now()'
        + " where id = $1 and status = 'active'",
        [supersedes, reviewedBy ?? null, id]);
      if (r.rowCount !== 1) {
        throw new Error('supersedes target is not active: ' + supersedes);
      }
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return true;
}

/* ------------------------------------------------------------- captures */

/* putCapture: insert ONE capture row (one accepted capture = one point)
 * and return { id, points } — the author's total AFTER the insert (the
 * 201 body). The duplicate prevention is the unique (author_uid,
 * content_hash) index (the race backstop): a violation is mapped to a
 * typed error the route turns into 409 — never leak raw pg error text. */
export async function putCapture(pool, c) {
  try {
    await pool.query(
      'insert into captures (id, author_uid, author_name, author_email,'
      + ' junction, method, captured_at, content_hash, object_key,'
      + ' file_name, content_type, byte_size, geo_lat, geo_lng)'
      + ' values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,'
      + ' $13, $14)',
      [c.id, c.authorUid, c.authorName, c.authorEmail ?? null,
        c.junction, c.method, c.capturedAt ?? null, c.contentHash,
        c.objectKey, c.fileName, c.contentType, c.byteSize,
        c.geoLat ?? null, c.geoLng ?? null]);
  } catch (e) {
    if (e && e.code === '23505') {
      throw Object.assign(new Error('already uploaded'),
        { code: 'CAPTURE_DUPLICATE' });
    }
    throw e;
  }
  const r = await pool.query(
    'select count(*) as n from captures where author_uid = $1',
    [c.authorUid]);
  return { id: c.id, points: Number(r.rows[0].n) };
}

/* findCaptureHash: the pre-upload duplicate lookup — the author's row for
 * this exact content hash, or null (scoped PER AUTHOR: the same bytes from
 * another commuter are a fresh capture). */
export async function findCaptureHash(pool, authorUid, contentHash) {
  const r = await pool.query(
    'select id from captures where author_uid = $1 and content_hash = $2',
    [authorUid, contentHash]);
  return r.rows.length ? r.rows[0] : null;
}

/* listLeaderboard: all-time totals, ranked by the route (this returns the
 * ORDERED rows: points desc, tie-break by earliest MAX(created_at) — the
 * commuter who reached their total first ranks higher). The display name
 * comes from the author's MOST RECENT row (array_agg ordered inside the
 * group), so a rename never splits a user into two entries. points is a
 * number — pg returns count(*) as int8/string otherwise. */
export async function listLeaderboard(pool, { limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const r = await pool.query(
    'select (array_agg(author_name order by created_at desc))[1] as name,'
    + ' count(*) as points from captures'
    + ' group by author_uid'
    + ' order by count(*) desc, max(created_at) asc limit $1',
    [lim]);
  return r.rows.map((row) => ({
    name: row.name, points: Number(row.points),
  }));
}

/* -------------------------------------------------- capture moderation */

/* listCaptures: the admin moderation feed — every capture, newest first.
 * byte_size is normalized to a number (pg int8 arrives as a string, which
 * would poison the UI's size rendering — same guard as getUploadRef).
 * object_key/content_hash stay out of the list: internal columns ride on
 * getCapture only. */
export async function listCaptures(pool, { limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const r = await pool.query(
    'select id, author_uid, author_name, author_email, junction, method,'
    + ' captured_at, file_name, content_type, byte_size, geo_lat, geo_lng,'
    + ' created_at from captures order by created_at desc limit $1',
    [lim]);
  return r.rows.map((row) => ({ ...row, byte_size: Number(row.byte_size) }));
}

/* getCapture: the full row (object_key + content_type feed the file proxy)
 * or null when absent (route maps that to 404). */
export async function getCapture(pool, id) {
  const r = await pool.query('select * from captures where id = $1', [id]);
  return r.rows.length ? r.rows[0] : null;
}

/* deleteCapture: the hard delete — one row IS one leaderboard point, so
 * removing it self-heals the count(*) leaderboard (an author's last row
 * removes them entirely). No status/soft-delete: the reason lives in the
 * uploader email, not in any table. Returns whether a row was removed. */
export async function deleteCapture(pool, id) {
  const r = await pool.query('delete from captures where id = $1', [id]);
  return r.rowCount > 0;
}