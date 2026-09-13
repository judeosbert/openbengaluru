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
 * keys/urls/sizes are stored verbatim. Resolves to the sorted stored names.
 * Any failure rolls the whole put back (the sims upsert included). */
export async function putUploadRefs(pool, id, body, refs) {
  const b = body || {};
  const rows = refs || [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      'insert into sims (id, title, author, description, anchor_lat,'
      + ' anchor_lng, rotation) values ($1, $2, $3, $4, $5, $6, $7)'
      + ' on conflict (id) do update set'
      + ' title = excluded.title,'
      + ' author = excluded.author,'
      + ' description = excluded.description,'
      + ' anchor_lat = excluded.anchor_lat,'
      + ' anchor_lng = excluded.anchor_lng,'
      + ' rotation = excluded.rotation,'
      + ' updated_at = now()',
      [id, b.title, b.author ?? null, b.desc ?? null,
        b.anchor?.[0] ?? null, b.anchor?.[1] ?? null, b.rotation ?? null]);
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