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