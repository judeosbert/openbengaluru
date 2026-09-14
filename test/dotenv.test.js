/* Contract for the .env loader used by the dev launcher: `npm run dev` must
 * work with a repo-root .env present (shell sourcing is only documented for
 * npm start). Regression for the 2026-09-13 failure where dev_all.js spawned
 * server.js with bare process.env and crashed fail-fast on missing PG* vars.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDotEnv, loadDotEnvFile } from '../tools/dotenv.js';

describe('parseDotEnv', () => {
  it('parses KEY=VALUE, skips comments/blank/invalid lines', () => {
    const text = [
      '# leading comment',
      '',
      'PGHOST=localhost',
      '  PGPORT = 5432  ',
      'not a pair',
      '=nokey',
      'SIMO_S3_REGION=us-east-1',
    ].join('\n');
    expect(parseDotEnv(text)).toEqual({
      PGHOST: 'localhost',
      PGPORT: '5432',
      SIMO_S3_REGION: 'us-east-1',
    });
  });

  it('strips matching surrounding quotes, keeps empty values', () => {
    const env = parseDotEnv([
      'A="quoted value"',
      "B='single quoted'",
      'C=',
      'D="unmatched',
    ].join('\n'));
    expect(env).toEqual({ A: 'quoted value', B: 'single quoted', C: '', D: '"unmatched' });
  });

  it('tolerates CRLF line endings', () => {
    expect(parseDotEnv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('loadDotEnvFile', () => {
  it('merges file values under the base env — base wins', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-env-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'PGHOST=from-file\nPGPORT=5432\n', 'utf8');
    const out = loadDotEnvFile(file, { PGHOST: 'from-shell' });
    expect(out).toEqual({ PGHOST: 'from-shell', PGPORT: '5432' });
  });

  it('tolerates a missing .env — returns the base env unchanged', () => {
    const base = { PGHOST: 'x' };
    expect(loadDotEnvFile('/nonexistent/.env', base)).toEqual(base);
  });

  it('loads a full simo-player .env (the incident payload)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-env-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, [
      '# simo-player dev env',
      'PGHOST=localhost',
      'PGPORT=5432',
      'PGUSER=postgres',
      'PGPASSWORD=secret',
      'PGDATABASE=simo_player',
      'SIMO_S3_BUCKET=simo-uploads-dev',
      'SIMO_S3_ACCESS_KEY_ID=minioadmin',
      'SIMO_S3_SECRET_ACCESS_KEY=minioadmin',
      'GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa.json',
      'SIMO_ADMIN_EMAILS=a@example.com,b@example.com',
    ].join('\n'), 'utf8');
    const out = loadDotEnvFile(file, {});
    for (const k of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
      'SIMO_S3_BUCKET', 'SIMO_S3_ACCESS_KEY_ID', 'SIMO_S3_SECRET_ACCESS_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS', 'SIMO_ADMIN_EMAILS']) {
      expect(out[k], k + ' must be loaded from .env').toBeTruthy();
    }
  });
});
