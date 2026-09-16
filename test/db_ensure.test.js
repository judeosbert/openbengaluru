/* Startup DB auto-provisioning (db.js ensureDbReady): when the server can
 * reach Postgres it provisions everything itself — a missing database is
 * created via a maintenance connection (SQLSTATE 3D000 path) and
 * db/schema.sql is applied in one transaction; re-runs are idempotent; any
 * other connection failure propagates to the caller (main() exits non-zero
 * so the platform restarts). The createSimServer wiring is locked too: the
 * default env-pool branch exposes a dbReady promise on the server, the
 * opts.db test-seam branch leaves it null.
 *
 * Runs against REAL Postgres (five PG* vars, no defaults — see
 * .env.example). Uses a scratch ${PGDATABASE}_test_ensure database,
 * dropped and recreated per case; the maintenance connection is the
 * existing ${PGDATABASE}_test database (guaranteed by ensureTestDb).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { ensureDbReady } from '../db.js';
import { createSimServer } from '../server.js';
import { ensureTestDb, testDbName, requirePgEnv } from './helpers/pgTest.js';

requirePgEnv();

const ENSURE_DB = testDbName() + '_ensure';

function pgConn() {
  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  };
}

async function dropDb(name) {
  const admin = new pg.Pool({ ...pgConn(), database: 'postgres' });
  try {
    await admin.query('drop database if exists "' + name + '"');
  } finally {
    await admin.end();
  }
}

async function tableCount(pool, names) {
  const r = await pool.query(
    'select table_name from information_schema.tables'
    + " where table_schema = 'public' and table_name = any($1)"
    + ' order by table_name', [names]);
  return r.rows.map((x) => x.table_name);
}

beforeAll(async () => {
  await ensureTestDb();
  await dropDb(ENSURE_DB);
});

afterAll(async () => {
  await dropDb(ENSURE_DB);
});

describe('ensureDbReady', () => {
  it('creates a missing database and applies the schema', async () => {
    const conn = { ...pgConn(), database: ENSURE_DB };
    const pool = new pg.Pool(conn);
    try {
      await ensureDbReady(pool, conn, { maintenanceDb: testDbName() });
      expect(await tableCount(pool, ['sims', 'sim_files']))
        .toEqual(['sim_files', 'sims']);
    } finally {
      await pool.end();
    }
  }, 30000);

  it('is idempotent on an existing database', async () => {
    const conn = { ...pgConn(), database: ENSURE_DB };
    const pool = new pg.Pool(conn);
    try {
      await ensureDbReady(pool, conn, { maintenanceDb: testDbName() });
      await ensureDbReady(pool, conn, { maintenanceDb: testDbName() });
      await pool.query('select * from sims limit 0');
      expect(await tableCount(pool, ['sims', 'sim_files']))
        .toEqual(['sim_files', 'sims']);
    } finally {
      await pool.end();
    }
  }, 30000);

  it('accepts a DATABASE_URL-style connectionString', async () => {
    const enc = encodeURIComponent;
    const conn = { connectionString: 'postgres://'
      + enc(process.env.PGUSER) + ':' + enc(process.env.PGPASSWORD)
      + '@' + process.env.PGHOST + ':' + process.env.PGPORT
      + '/' + ENSURE_DB };
    const pool = new pg.Pool(conn);
    try {
      await ensureDbReady(pool, conn, { maintenanceDb: testDbName() });
      await pool.query('select * from sims limit 0');
    } finally {
      await pool.end();
    }
  }, 30000);

  it('propagates connection failures (no maintenance retry)', async () => {
    const conn = { ...pgConn(), port: 59999, database: ENSURE_DB };
    const pool = new pg.Pool(conn);
    try {
      await expect(
        ensureDbReady(pool, conn, { maintenanceDb: testDbName() }),
      ).rejects.toThrow();
    } finally {
      await pool.end();
    }
  }, 30000);
});

describe('createSimServer db-provision wiring', () => {
  const seams = {
    verifyToken: async () => null,
    mailer: { send: async () => {} },
    sumoResolver: () => null,
    bucket: {},
    pool: { close() {} },
  };

  it('attaches dbReady on the default env pool; schema present after', async () => {
    const db = testDbName();
    const prevDb = process.env.PGDATABASE;
    process.env.PGDATABASE = db;
    const server = createSimServer(seams);
    try {
      expect(server.dbReady).toBeInstanceOf(Promise);
      await server.dbReady;
      const pool = new pg.Pool({ ...pgConn(), database: db });
      try {
        expect(await tableCount(pool, ['sims'])).toEqual(['sims']);
      } finally {
        await pool.end();
      }
    } finally {
      server.close();
      process.env.PGDATABASE = prevDb;
    }
  }, 30000);

  it('leaves dbReady null when opts.db is injected', () => {
    const server = createSimServer({ ...seams, db: {} });
    try {
      expect(server.dbReady).toBeNull();
    } finally {
      server.close();
    }
  });
});
