#!/usr/bin/env node
/* One-shot DB provisioning (no migration framework): creates the dev
 * database (PGDATABASE) and its ${PGDATABASE}_test sibling (unless
 * --no-test-db), then applies db/schema.sql to each — idempotent DDL in a
 * transaction. CREATE DATABASE connects to the maintenance db (default
 * "postgres"; --maintenance-db overrides) and uses a parameterized
 * existence check + a double-quoted identifier — the only dynamic
 * identifiers in this repo's SQL, validated against ^[a-z0-9_]+$ first.
 * Connection env resolves exactly like the server's (PG* vars, or
 * DATABASE_URL/SIMO_DATABASE_URL overriding wholesale).
 *
 *   npm run db:setup
 *   node tools/db_setup.js --no-test-db
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnFromEnv } from '../db.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCHEMA_SQL = fs.readFileSync(
  path.join(ROOT, 'db', 'schema.sql'), 'utf8');

const NAME_RE = /^[a-z0-9_]+$/;

function parseArgs(argv) {
  const args = process.argv.slice(2);
  const noTestDb = args.includes('--no-test-db');
  const mi = args.indexOf('--maintenance-db');
  const maintenanceDb = mi >= 0 ? args[mi + 1] : 'postgres';
  if (!NAME_RE.test(maintenanceDb)) {
    throw new Error('invalid maintenance db name: '
      + JSON.stringify(maintenanceDb));
  }
  return { noTestDb, maintenanceDb };
}

/* Connection options for a specific database, whatever env shape won.
 * DATABASE_URL: rewrite the path; discrete PG*: override the database. */
function connFor(env, db) {
  const base = pgConnFromEnv(env);
  if (base.connectionString) {
    const u = new URL(base.connectionString);
    u.pathname = '/' + db;
    return { connectionString: u.toString() };
  }
  return { ...base, database: db };
}

function primaryDbName(env) {
  const url = env.DATABASE_URL || env.SIMO_DATABASE_URL;
  if (url) {
    const name = decodeURIComponent(
      new URL(url).pathname.replace(/^\//, ''));
    if (!name) {
      throw new Error('DATABASE_URL carries no database name');
    }
    return name;
  }
  return env.PGDATABASE;
}

async function main() {
  const env = process.env;
  const { noTestDb, maintenanceDb } = parseArgs(process.argv);
  const primary = primaryDbName(env);
  if (!NAME_RE.test(primary)) {
    throw new Error('database name must match ^[a-z0-9_]+$, got: '
      + JSON.stringify(primary));
  }
  const targets = [primary];
  if (!noTestDb) targets.push(primary + '_test');
  for (const t of targets.slice(1)) {
    if (!NAME_RE.test(t)) {
      throw new Error('derived test db name must match ^[a-z0-9_]+$, got: '
        + JSON.stringify(t));
    }
  }

  /* CREATE DATABASE phase — maintenance connection only */
  const admin = new pg.Pool(connFor(env, maintenanceDb));
  try {
    for (const name of targets) {
      const exists = await admin.query(
        'select 1 from pg_database where datname = $1', [name]);
      if (exists.rowCount === 0) {
        await admin.query('create database "' + name + '"');
        process.stdout.write(name + ': database created\n');
      } else {
        process.stdout.write(name + ': database exists\n');
      }
    }
  } finally {
    await admin.end();
  }

  /* schema phase — idempotent DDL, one transaction per database */
  for (const name of targets) {
    const pool = new pg.Pool(connFor(env, name));
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(SCHEMA_SQL);
      await client.query('commit');
      process.stdout.write(name + ': schema applied\n');
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
      await pool.end();
    }
  }
}

main().catch((e) => {
  process.stderr.write('db_setup failed: '
    + String((e && e.message) || e) + '\n');
  process.exit(1);
});