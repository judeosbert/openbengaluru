/* db.js capture/leaderboard unit tests — REAL Postgres against the test
 * database ${PGDATABASE}_test (schema applied from db/schema.sql via pgTest,
 * so the suite self-provisions). Locks the captures API the server's
 * /api/captures routes are built on (plan: capture-leaderboard page):
 *
 * - putCapture: one row = one point — { id, points } with points the
 *   author's total AFTER the insert; all metadata columns stored verbatim
 *   (junction, method, captured_at, content_hash, object_key, file_name,
 *   content_type, byte_size, geo_lat/geo_lng RAW or null).
 * - duplicate guard: unique (author_uid, content_hash) — a same-author
 *   re-upload throws code 'CAPTURE_DUPLICATE' ('already uploaded'), while
 *   the SAME bytes from ANOTHER author stay legal (per-author rule).
 * - CHECK constraints: method enum; junction non-empty.
 * - findCaptureHash: the pre-upload dup lookup, scoped per author.
 * - listLeaderboard: points DESC, tie-break by earliest MAX(created_at)
 *   (the author who reached their total first ranks higher), display name
 *   from the MOST RECENT row (renames don't split users), points as a
 *   NUMBER (int8 poison guard), limit honored.
 * - moderation API (plan: capture-admin-moderation): listCaptures (admin
 *   feed, created_at DESC, byte_size normalized to a number, limit clamp),
 *   getCapture (full row for the file proxy), deleteCapture (hard delete —
 *   the leaderboard point self-heals on count(*)).
 *
 * Needs all five PG* vars (no defaults, mirroring db.js's fail-fast
 * contract): PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE.
 */
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  putCapture, findCaptureHash, listLeaderboard,
  listCaptures, getCapture, deleteCapture,
} from '../db.js';
import { ensureTestDb, testPool, requirePgEnv } from './helpers/pgTest.js';

requirePgEnv();

const POOLS = [];
let pool;
let seq = 0;

beforeAll(async () => {
  await ensureTestDb();
  const pool0 = testPool();
  POOLS.push(pool0);
  pool = pool0;
});

beforeEach(async () => {
  await pool.query('truncate captures');
});

afterAll(async () => {
  for (const p of POOLS) await p.end();
});

function cap(over = {}) {
  seq += 1;
  return {
    id: 'cap-t' + seq,
    authorUid: 'uid-qa',
    authorName: 'qa user',
    authorEmail: 'qa@x.test',
    junction: 'Silk Board Junction',
    method: 'snapshot',
    capturedAt: new Date('2026-01-02T03:04:05.000Z'),
    contentHash: 'hash-' + seq,
    objectKey: 'captures/cap-t' + seq + '/cap-t' + seq + '_silk-board.mp4',
    fileName: 'cap-t' + seq + '_silk-board.mp4',
    contentType: 'video/mp4',
    byteSize: 1234,
    geoLat: 12.9712,
    geoLng: 77.723,
    ...over,
  };
}

async function row(id) {
  return (await pool.query('select * from captures where id = $1',
    [id])).rows[0];
}

/* ------------------------------------------------------ putCapture roundtrip --- */

it('putCapture stores the row and returns { id, points: 1 }', async () => {
  const c = cap();
  expect(await putCapture(pool, c)).toEqual({ id: c.id, points: 1 });
  expect(await row(c.id)).toBeTruthy();
});

/* per-column storage is asserted in the next test */

it('putCapture stores metadata verbatim; geo is RAW (no validation)', async () => {
  const c = cap();
  await putCapture(pool, c);
  const r = await row(c.id);
  expect(r.author_uid).toBe('uid-qa');
  expect(r.author_name).toBe('qa user');
  expect(r.author_email).toBe('qa@x.test');
  expect(r.junction).toBe('Silk Board Junction');
  expect(r.method).toBe('snapshot');
  expect(r.captured_at).toBeInstanceOf(Date);
  expect(r.captured_at.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  expect(r.content_hash).toBe(c.contentHash);
  expect(r.object_key).toBe(c.objectKey);
  expect(r.file_name).toBe(c.fileName);
  expect(r.content_type).toBe('video/mp4');
  /* the raw row's BIGINT arrives as a string (pg int8) — db.js normalizes
   * int8 to a number only where an API consumer needs it (getUploadRef
   * precedent); nothing downstream reads capture byte_size */
  expect(Number(r.byte_size)).toBe(1234);
  expect(r.geo_lat).toBeCloseTo(12.9712);
  expect(r.geo_lng).toBeCloseTo(77.723);
  expect(r.created_at).toBeInstanceOf(Date);
});

it('a minimal capture stores nulls for capturedAt/geo', async () => {
  const c = cap({ capturedAt: null, geoLat: null, geoLng: null });
  await putCapture(pool, c);
  const r = await row(c.id);
  expect(r.captured_at).toBeNull();
  expect(r.geo_lat).toBeNull();
  expect(r.geo_lng).toBeNull();
});

/* ------------------------------------------------------------------ points --- */

it('points accumulate per author; a second capture returns the new total', async () => {
  const a = cap();
  expect((await putCapture(pool, a)).points).toBe(1);
  const b = cap({ contentHash: 'hash-other-bytes' });
  expect((await putCapture(pool, b)).points).toBe(2);
  /* a different author starts at their own 1 */
  const other = cap({ authorUid: 'uid-other', authorName: 'other user',
    authorEmail: 'other@x.test', contentHash: 'hash-third' });
  expect((await putCapture(pool, other)).points).toBe(1);
});

/* --------------------------------------------------------------- duplicate --- */

it('same author + same content hash is rejected as a duplicate', async () => {
  const c = cap();
  await putCapture(pool, c);
  await expect(putCapture(pool, cap({ id: 'cap-dupe',
    contentHash: c.contentHash })))
    .rejects.toMatchObject({ code: 'CAPTURE_DUPLICATE' });
  await expect(putCapture(pool, cap({ id: 'cap-dupe2',
    contentHash: c.contentHash })))
    .rejects.toThrow(/already uploaded/);
  expect((await pool.query('select count(*)::int as n from captures'))
    .rows[0].n).toBe(1);
});

it('the SAME bytes from ANOTHER author are legal (per-author rule)', async () => {
  const c = cap();
  await putCapture(pool, c);
  const other = cap({ id: 'cap-fresh', authorUid: 'uid-other',
    authorName: 'other user', authorEmail: 'other@x.test',
    contentHash: c.contentHash });
  const r = await putCapture(pool, other);
  expect(r.points).toBe(1);
});

/* the unique index is the race backstop — the violation maps to the same
 * typed error the route turns into 409. */
it('the unique index rejects the duplicate even across the app-level check',
  async () => {
    const c = cap();
    await putCapture(pool, c);
    await expect(putCapture(pool, cap({ id: 'cap-race',
      contentHash: c.contentHash })))
      .rejects.toMatchObject({ code: 'CAPTURE_DUPLICATE' });
  });

/* --------------------------------------------------------- CHECK guards --- */

it('an unknown method is rejected by the method CHECK', async () => {
  await expect(putCapture(pool, cap({ method: 'vibes' })))
    .rejects.toThrow(/check constraint/i);
});

it('an empty/whitespace junction is rejected', async () => {
  await expect(putCapture(pool, cap({ junction: '   ' })))
    .rejects.toThrow(/check constraint/i);
});

/* ---------------------------------------------------------- findCaptureHash --- */

it('findCaptureHash is scoped per author; unknown -> null', async () => {
  const c = cap();
  await putCapture(pool, c);
  const hit = await findCaptureHash(pool, 'uid-qa', c.contentHash);
  expect(hit).toBeTruthy();
  expect(hit.id).toBe(c.id);
  expect(await findCaptureHash(pool, 'uid-other', c.contentHash)).toBeNull();
  expect(await findCaptureHash(pool, 'uid-qa', 'hash-never')).toBeNull();
});

/* ------------------------------------------------------------- leaderboard --- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

it('listLeaderboard orders by points desc, tie-break earliest latest-capture',
  async () => {
    /* alice: 2 points early; bob: 2 points later; carol: 1 point */
    await putCapture(pool, cap({ id: 'cap-a1', authorUid: 'alice',
      authorName: 'Alice', contentHash: 'h-a1' }));
    await sleep(20);
    await putCapture(pool, cap({ id: 'cap-a2', authorUid: 'alice',
      authorName: 'Alice', contentHash: 'h-a2' }));
    await sleep(20);
    await putCapture(pool, cap({ id: 'cap-b1', authorUid: 'bob',
      authorName: 'Bob', contentHash: 'h-b1' }));
    await sleep(20);
    await putCapture(pool, cap({ id: 'cap-b2', authorUid: 'bob',
      authorName: 'Bob', contentHash: 'h-b2' }));
    await sleep(20);
    await putCapture(pool, cap({ id: 'cap-c1', authorUid: 'carol',
      authorName: 'Carol', contentHash: 'h-c1', method: 'footbridge' }));

    const rows = await listLeaderboard(pool, {});
    expect(rows.map((r) => [r.name, r.points])).toEqual([
      ['Alice', 2], ['Bob', 2], ['Carol', 1],
    ]);
    for (const r of rows) {
      expect(typeof r.points).toBe('number');
    }
  });

it('listLeaderboard shows the name from the MOST RECENT row (renames)', async () => {
  await putCapture(pool, cap({ id: 'cap-n1', authorUid: 'alice',
    authorName: 'Alice', contentHash: 'h-n1' }));
  await sleep(20);
  await putCapture(pool, cap({ id: 'cap-n2', authorUid: 'alice',
    authorName: 'Alicia', contentHash: 'h-n2' }));
  const rows = await listLeaderboard(pool, {});
  expect(rows).toEqual([{ name: 'Alicia', points: 2 }]);
});

it('listLeaderboard honors the limit', async () => {
  for (const [i, uid] of ['u1', 'u2', 'u3'].entries()) {
    await putCapture(pool, cap({ id: 'cap-l' + i, authorUid: uid,
      authorName: 'user' + i, contentHash: 'h-l' + i }));
    await sleep(10);
  }
  /* equal points -> earliest latest-capture first: user0 was inserted
   * first, so it outranks the later 1-point users */
  expect(await listLeaderboard(pool, { limit: 2 }))
    .toEqual([{ name: 'user0', points: 1 }, { name: 'user1', points: 1 }]);
  expect((await listLeaderboard(pool, {})).length).toBe(3);
  expect((await listLeaderboard(pool, { limit: 100 })).length).toBe(3);
});

/* -------------------------------------------------- moderation (admin feed) --- */

it('listCaptures returns rows newest-first with the admin feed shape',
  async () => {
    await putCapture(pool, cap({ id: 'cap-m1', authorUid: 'alice',
      authorName: 'Alice', authorEmail: 'alice@x.test',
      contentHash: 'h-m1' }));
    await sleep(20);
    await putCapture(pool, cap({ id: 'cap-m2', authorUid: 'bob',
      authorName: 'Bob', authorEmail: null, method: 'footbridge',
      contentHash: 'h-m2' }));

    const rows = await listCaptures(pool, {});
    expect(rows.map((r) => r.id)).toEqual(['cap-m2', 'cap-m1']);
    for (const r of rows) {
      for (const f of ['id', 'author_name', 'author_email', 'junction',
        'method', 'captured_at', 'created_at', 'byte_size', 'content_type',
        'geo_lat', 'geo_lng']) {
        expect(f in r, `row must carry ${f}`).toBe(true);
      }
      /* int8 poison guard — the UI renders the size directly */
      expect(typeof r.byte_size).toBe('number');
      expect(r.byte_size).toBe(1234);
    }
    expect(rows[0]).toMatchObject({
      author_name: 'Bob', author_email: null, junction: 'Silk Board Junction',
      method: 'footbridge', geo_lat: 12.9712, geo_lng: 77.723,
    });
    expect(rows[1]).toMatchObject({
      author_name: 'Alice', author_email: 'alice@x.test',
      method: 'snapshot',
    });
  });

it('listCaptures honors the limit (clamped, default 100)', async () => {
  for (const i of [1, 2, 3]) {
    await putCapture(pool, cap({ id: 'cap-lim' + i,
      contentHash: 'h-lim' + i }));
  }
  expect((await listCaptures(pool, {})).length).toBe(3);
  expect((await listCaptures(pool, { limit: 2 })).map((r) => r.id))
    .toEqual(['cap-lim3', 'cap-lim2']);
  /* clamp floor: a nonsense limit still returns one row, never zero/neg */
  expect((await listCaptures(pool, { limit: -5 })).length).toBe(1);
});

it('getCapture returns the full row (object_key + content_type for the '
  + 'file proxy); miss -> null', async () => {
  const c = cap({ id: 'cap-get' });
  await putCapture(pool, c);
  const r = await getCapture(pool, c.id);
  expect(r).toBeTruthy();
  expect(r.junction).toBe('Silk Board Junction');
  expect(r.object_key).toBe(c.objectKey);
  expect(r.file_name).toBe(c.fileName);
  expect(r.content_type).toBe('video/mp4');
  expect(r.author_uid).toBe('uid-qa');
  expect(await getCapture(pool, 'cap-unknown')).toBeNull();
});

it('deleteCapture hard-deletes: true + row gone, missing id -> false',
  async () => {
    const c = cap({ id: 'cap-del' });
    await putCapture(pool, c);
    expect(await deleteCapture(pool, c.id)).toBe(true);
    expect(await row(c.id)).toBeUndefined();
    expect(await deleteCapture(pool, c.id)).toBe(false);
    expect(await deleteCapture(pool, 'cap-never')).toBe(false);
  });

it('deleteCapture drops the leaderboard point; a lone row removes the author',
  async () => {
    await putCapture(pool, cap({ id: 'cap-pa1', authorUid: 'alice',
      authorName: 'Alice', contentHash: 'h-pa1' }));
    await putCapture(pool, cap({ id: 'cap-pa2', authorUid: 'alice',
      authorName: 'Alice', contentHash: 'h-pa2' }));
    await putCapture(pool, cap({ id: 'cap-pb1', authorUid: 'bob',
      authorName: 'Bob', contentHash: 'h-pb1' }));
    expect(await listLeaderboard(pool, {})).toEqual([
      { name: 'Alice', points: 2 }, { name: 'Bob', points: 1 }]);

    expect(await deleteCapture(pool, 'cap-pa1')).toBe(true);
    expect(await listLeaderboard(pool, {})).toEqual([
      { name: 'Alice', points: 1 }, { name: 'Bob', points: 1 }]);

    /* Bob's only row -> he vanishes from the leaderboard entirely */
    expect(await deleteCapture(pool, 'cap-pb1')).toBe(true);
    expect(await listLeaderboard(pool, {}))
      .toEqual([{ name: 'Alice', points: 1 }]);
  });