/* Shared real-Postgres bootstrap for the suites that hit the DB
 * (db_uploads, endpoint): require the five PG* vars (fail fast listing
 * them — no defaults, mirroring db.js's contract), ensure the
 * ${PGDATABASE}_test database exists (created from the maintenance db via a
 * validated, double-quoted identifier — the one dynamic identifier) and
 * apply db/schema.sql (idempotent).
 *
 * Deliberately does NOT import db.js — that module is under test here; the
 * harness resolves its own plain pg.Pool against the test database.
 * PGPASSWORD is never logged. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

export const PG_REQUIRED = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD',
  'PGDATABASE'];

export function requirePgEnv() {
  const missing = PG_REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error('missing env: ' + missing.join(', ')
      + ' — these tests run against real Postgres (see .env.example)');
  }
}

export function testDbName() {
  requirePgEnv();
  const name = process.env.PGDATABASE + '_test';
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error('PGDATABASE must match ^[a-z0-9_]+$ to derive the test '
      + 'db name, got: ' + JSON.stringify(process.env.PGDATABASE));
  }
  return name;
}

function pgConn() {
  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  };
}

let ensured = null;

/* Idempotent; concurrent callers share one bootstrap. */
export function ensureTestDb() {
  if (!ensured) {
    ensured = (async () => {
      const admin = new pg.Pool({ ...pgConn(), database: 'postgres' });
      try {
        const exists = await admin.query(
          'select 1 from pg_database where datname = $1', [testDbName()]);
        if (exists.rowCount === 0) {
          await admin.query('create database "' + testDbName() + '"');
        }
      } finally {
        await admin.end();
      }
      const pool = new pg.Pool({ ...pgConn(), database: testDbName() });
      try {
        await pool.query(fs.readFileSync(
          path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
      } finally {
        await pool.end();
      }
    })();
  }
  return ensured;
}

export function testPool() {
  return new pg.Pool({ ...pgConn(), database: testDbName() });
}