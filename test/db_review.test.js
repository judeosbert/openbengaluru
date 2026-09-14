/* db.js review-flow unit tests — REAL Postgres against the test database
 * ${PGDATABASE}_test (schema applied from db/schema.sql via pgTest, so the
 * suite self-provisions). Locks the review workflow API the server's
 * catalog/submission routes are built on:
 *
 * - putUploadRefs author-identity columns (author_uid/author_email) and the
 *   on-conflict contract: metadata + refs + author fields ONLY — the
 *   review state (status/sim_ready/entry_json) survives a re-put.
 * - finalizeSim: entry_json + sim_ready + list columns + the reset
 *   semantics (status pending, reviewed_by/at null, superseded_by null).
 * - listSubmissions: pending-first then created_at desc, owner scoping,
 *   status filter, comment_count (bigint -> number).
 * - getSubmission (row|null), listActiveEntries (active + entry_json).
 * - addComment/listComments thread (order, is_admin, CHECK guard, cascade).
 * - setStatus (reject/deactivate).
 * - activateTx: one tx — activated row active + reviewed, superseded row
 *   inactive + superseded_by; supersedes-target race guard (not active ->
 *   nothing changes); no-supersedes leaves other rows untouched.
 *
 * Needs all five PG* vars (no defaults, mirroring db.js's fail-fast
 * contract): PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE.
 */
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  putUploadRefs, finalizeSim, listSubmissions, getSubmission,
  listActiveEntries, listComments, addComment, setStatus, activateTx,
} from '../db.js';
import { ensureTestDb, testPool, requirePgEnv } from './helpers/pgTest.js';

requirePgEnv();

const POOLS = [];
let pool;

beforeAll(async () => {
  await ensureTestDb();
  const pool0 = testPool();
  POOLS.push(pool0);
  pool = pool0;
});

beforeEach(async () => {
  await pool.query('truncate sims cascade');
});

afterAll(async () => {
  for (const p of POOLS) await p.end();
});

function body(over = {}) {
  return {
    title: 'Review flow test',
    author: 'qa user',
    desc: 'db review round-trip',
    anchor: [12.97, 77.72],
    rotation: 7,
    authorUid: 'uid-qa',
    authorEmail: 'qa@x.test',
    ...over,
  };
}

function refs(id, names = ['today.net.xml', 'demand.rou.xml']) {
  return names.map((name) => ({
    name,
    object_key: 'k/' + id + '/' + name,
    object_url: 'u/' + id + '/' + name,
    size_bytes: 11,
  }));
}

async function row(id) {
  return (await pool.query('select * from sims where id = $1', [id])).rows[0];
}

/* ------------------------------------------------- putUploadRefs identity --- */

it('putUploadRefs stores the author identity columns', async () => {
  await putUploadRefs(pool, 'rev-auth', body(), refs('rev-auth'));
  const r = await row('rev-auth');
  expect(r.author_uid).toBe('uid-qa');
  expect(r.author_email).toBe('qa@x.test');
  expect(r.status).toBe('pending');          // fresh submission default
  expect(r.sim_ready).toBe(false);
  expect(r.entry_json).toBeNull();
});

it('re-put updates metadata + author fields but never the review state', async () => {
  const id = 'rev-keep';
  await putUploadRefs(pool, id, body(), refs(id));
  await finalizeSim(pool, id, {
    entryJson: { id, title: 'Review flow test', demand: 150 },
    demand: 150, peakServed: 90, hasProposed: false,
  });
  await setStatus(pool, id, { status: 'active', reviewedBy: 'admin-1' });
  // a re-pipeline replaces the sources...
  await putUploadRefs(pool, id, {
    ...body({ title: 'Replaced', authorUid: 'uid-qa2',
      authorEmail: 'qa2@x.test' }),
  }, refs(id));
  const r = await row(id);
  expect(r.title).toBe('Replaced');
  expect(r.author_uid).toBe('uid-qa2');
  expect(r.author_email).toBe('qa2@x.test');
  // ...and the review state is untouched by the replace
  expect(r.status).toBe('active');
  expect(r.sim_ready).toBe(true);
  expect(r.entry_json).toEqual({ id, title: 'Review flow test', demand: 150 });
  expect(r.reviewed_by).toBe('admin-1');
  expect(r.demand).toBe(150);
});

/* ------------------------------------------------------------- finalizeSim --- */

it('finalizeSim sets entry_json/sim_ready/list columns and resets review state',
  async () => {
    const id = 'rev-fin';
    await putUploadRefs(pool, id, body(), refs(id));
    await pool.query(
      'update sims set reviewed_by = $2, reviewed_at = now(),'
      + ' superseded_by = $3 where id = $1',
      [id, 'admin-1', 'other-run']);
    await finalizeSim(pool, id, {
      entryJson: { id, title: 'Review flow test', scenarios: {} },
      demand: 320, peakServed: 210, hasProposed: true,
    });
    const r = await row(id);
    expect(r.status).toBe('pending');
    expect(r.sim_ready).toBe(true);
    expect(r.reviewed_by).toBeNull();
    expect(r.reviewed_at).toBeNull();
    expect(r.superseded_by).toBeNull();
    expect(r.demand).toBe(320);
    expect(r.peak_served).toBe(210);
    expect(r.has_proposed).toBe(true);
    expect(r.entry_json).toEqual({ id, title: 'Review flow test',
      scenarios: {} });
  });

/* --------------------------------------------------------- listSubmissions --- */

it('listSubmissions returns rows + numeric comment_count, pending-first then created_at desc', async () => {
  const ids = ['rev-l1', 'rev-l2', 'rev-l3'];
  await putUploadRefs(pool, ids[0], body({ title: 'oldest' }), refs(ids[0]));
  await new Promise((r) => setTimeout(r, 10));
  await putUploadRefs(pool, ids[1], body({ title: 'middle' }), refs(ids[1]));
  await new Promise((r) => setTimeout(r, 10));
  await putUploadRefs(pool, ids[2], body({ title: 'newest' }), refs(ids[2]));
  await setStatus(pool, ids[1], { status: 'active', reviewedBy: 'admin-1' });
  await setStatus(pool, ids[2], { status: 'rejected', reviewedBy: 'admin-1' });
  await addComment(pool, ids[2], { author: 'admin', authorUid: 'admin-1',
    isAdmin: true, body: 'needs work' });
  await addComment(pool, ids[2], { author: 'qa', authorUid: 'uid-qa',
    isAdmin: false, body: 'fixed, please look' });

  const rows = await listSubmissions(pool, {});
  // pending-first (rev-l1), then non-pending by created_at desc
  // (rev-l3 is newer than rev-l2)
  expect(rows.map((r) => r.id)).toEqual([ids[0], ids[2], ids[1]]);
  const rejected = rows.find((r) => r.id === ids[2]);
  expect(rejected.comment_count).toBe(2);
  expect(typeof rejected.comment_count).toBe('number');
  expect(rejected.has_proposed).toBe(false);
  expect(rejected.sim_ready).toBe(false);
  expect(rejected.author_uid).toBe('uid-qa');
  expect(rejected).not.toHaveProperty('entry_json');

  // owner scoping
  await putUploadRefs(pool, 'rev-l4',
    body({ authorUid: 'uid-other', authorEmail: 'o@x.test' }), refs('rev-l4'));
  const mine = await listSubmissions(pool, { authorUid: 'uid-qa' });
  expect(mine.map((r) => r.id).sort()).toEqual(['rev-l1', 'rev-l2', 'rev-l3']);
  const theirs = await listSubmissions(pool, { authorUid: 'uid-other' });
  expect(theirs.map((r) => r.id)).toEqual(['rev-l4']);

  // status filter
  const rejectedRows = await listSubmissions(pool, { status: 'rejected' });
  expect(rejectedRows.map((r) => r.id)).toEqual([ids[2]]);
});

it('listSubmissions pending rows come before non-pending regardless of age', async () => {
  await putUploadRefs(pool, 'rev-p1', body(), refs('rev-p1'));
  await new Promise((r) => setTimeout(r, 10));
  await putUploadRefs(pool, 'rev-p2', body(), refs('rev-p2'));
  await setStatus(pool, 'rev-p1', { status: 'active', reviewedBy: 'a' });
  const rows = await listSubmissions(pool, {});
  expect(rows.map((r) => [r.id, r.status]))
    .toEqual([['rev-p2', 'pending'], ['rev-p1', 'active']]);
});

/* ------------------------------------------------------------ getSubmission --- */

it('getSubmission -> full row or null', async () => {
  expect(await getSubmission(pool, 'rev-unknown')).toBeNull();
  await putUploadRefs(pool, 'rev-get', body(), refs('rev-get'));
  const r = await getSubmission(pool, 'rev-get');
  expect(r.id).toBe('rev-get');
  expect(r.title).toBe('Review flow test');
  expect(r.entry_json).toBeNull();
});

/* -------------------------------------------------------- listActiveEntries --- */

it('listActiveEntries serves only active rows with an entry_json', async () => {
  await putUploadRefs(pool, 'rev-a1', body(), refs('rev-a1'));
  await putUploadRefs(pool, 'rev-a2', body(), refs('rev-a2'));
  await putUploadRefs(pool, 'rev-a3', body(), refs('rev-a3'));
  await finalizeSim(pool, 'rev-a1', { entryJson: { id: 'rev-a1', n: 1 },
    demand: 1, peakServed: 1, hasProposed: false });
  await finalizeSim(pool, 'rev-a2', { entryJson: { id: 'rev-a2', n: 2 },
    demand: 2, peakServed: 2, hasProposed: false });
  // a3 stays pending (no entry)
  await setStatus(pool, 'rev-a1', { status: 'active', reviewedBy: 'a' });
  await setStatus(pool, 'rev-a2', { status: 'rejected', reviewedBy: 'a' });
  const entries = await listActiveEntries(pool);
  expect(entries).toEqual([{ id: 'rev-a1', entry: { id: 'rev-a1', n: 1 } }]);
});

/* ----------------------------------------------------------------- comments --- */

it('addComment/listComments round-trips the thread (order, is_admin)', async () => {
  await putUploadRefs(pool, 'rev-c1', body(), refs('rev-c1'));
  const c1 = await addComment(pool, 'rev-c1', { author: 'admin',
    authorUid: 'admin-1', isAdmin: true, body: 'first note' });
  await new Promise((r) => setTimeout(r, 10));
  const c2 = await addComment(pool, 'rev-c1', { author: 'qa',
    authorUid: 'uid-qa', isAdmin: false, body: 'reply' });
  expect(typeof c1.id).toBe('number');
  expect(typeof c2.id).toBe('number');
  const thread = await listComments(pool, 'rev-c1');
  expect(thread.map((c) => c.body)).toEqual(['first note', 'reply']);
  expect(thread[0].is_admin).toBe(true);
  expect(thread[1].is_admin).toBe(false);
  expect(typeof thread[0].id).toBe('number');
  expect(thread[0].created_at).toBeInstanceOf(Date);
});

it('addComment rejects an empty/whitespace body (CHECK constraint)', async () => {
  await putUploadRefs(pool, 'rev-c2', body(), refs('rev-c2'));
  await expect(addComment(pool, 'rev-c2', { author: 'x', authorUid: 'u',
    isAdmin: false, body: '   ' })).rejects.toThrow(/check constraint/i);
  expect(await listComments(pool, 'rev-c2')).toEqual([]);
});

it('comments cascade-delete with their sim', async () => {
  await putUploadRefs(pool, 'rev-c3', body(), refs('rev-c3'));
  await addComment(pool, 'rev-c3', { author: 'x', authorUid: 'u',
    isAdmin: false, body: 'note' });
  await pool.query('delete from sims where id = $1', ['rev-c3']);
  expect(await listComments(pool, 'rev-c3')).toEqual([]);
});

/* --------------------------------------------------------------- setStatus --- */

it('setStatus flips status + stamps reviewed_by/at', async () => {
  await putUploadRefs(pool, 'rev-s1', body(), refs('rev-s1'));
  await setStatus(pool, 'rev-s1', { status: 'rejected', reviewedBy: 'admin-9' });
  const r = await row('rev-s1');
  expect(r.status).toBe('rejected');
  expect(r.reviewed_by).toBe('admin-9');
  expect(r.reviewed_at).toBeInstanceOf(Date);
});

/* --------------------------------------------------------------- activateTx --- */

it('activateTx activates the sim and supersedes the target in one transaction',
  async () => {
    await putUploadRefs(pool, 'rev-new', body(), refs('rev-new'));
    await finalizeSim(pool, 'rev-new', { entryJson: { id: 'rev-new' },
      demand: 1, peakServed: 1, hasProposed: false });
    await putUploadRefs(pool, 'rev-old', body(), refs('rev-old'));
    await finalizeSim(pool, 'rev-old', { entryJson: { id: 'rev-old' },
      demand: 1, peakServed: 1, hasProposed: false });
    await setStatus(pool, 'rev-old', { status: 'active', reviewedBy: 'a' });

    await activateTx(pool, 'rev-new', { reviewedBy: 'admin-1',
      supersedes: 'rev-old' });

    const nw = await row('rev-new');
    expect(nw.status).toBe('active');
    expect(nw.reviewed_by).toBe('admin-1');
    expect(nw.reviewed_at).toBeInstanceOf(Date);
    expect(nw.superseded_by).toBeNull();
    const old = await row('rev-old');
    expect(old.status).toBe('inactive');
    expect(old.superseded_by).toBe('rev-new');
    expect(old.reviewed_by).toBe('admin-1');
  });

it('activateTx without supersedes leaves other rows alone', async () => {
  await putUploadRefs(pool, 'rev-solo', body(), refs('rev-solo'));
  await putUploadRefs(pool, 'rev-bystander', body(), refs('rev-bystander'));
  await finalizeSim(pool, 'rev-solo', { entryJson: { id: 'rev-solo' },
    demand: 1, peakServed: 1, hasProposed: false });
  await setStatus(pool, 'rev-bystander', { status: 'active', reviewedBy: 'a' });
  await activateTx(pool, 'rev-solo', { reviewedBy: 'admin-1' });
  const s = await row('rev-solo');
  expect(s.status).toBe('active');
  expect(s.superseded_by).toBeNull();
  const b = await row('rev-bystander');
  expect(b.status).toBe('active');
  expect(b.superseded_by).toBeNull();
});

it('activateTx supersedes-target race guard: non-active target rolls back everything', async () => {
  await putUploadRefs(pool, 'rev-r1', body(), refs('rev-r1'));
  await putUploadRefs(pool, 'rev-r2', body(), refs('rev-r2'));
  await pool.query("update sims set status='rejected' where id='rev-r2'");
  await expect(activateTx(pool, 'rev-r1',
    { reviewedBy: 'admin-1', supersedes: 'rev-r2' })).rejects.toThrow();
  const r1 = await row('rev-r1');
  expect(r1.status).toBe('pending');       // rolled back, not activated
  const r2 = await row('rev-r2');
  expect(r2.status).toBe('rejected');
});