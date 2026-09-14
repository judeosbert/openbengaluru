/* Review-flow endpoint tests — REAL HTTP + REAL Postgres (${PGDATABASE}_test
 * via test/helpers/pgTest.js), an in-memory bucket seam twin (with the
 * review-artifact ops), and the opts.verifyToken / opts.db / opts.bucket /
 * opts.adminEmails seams. The review routes are pure DB/bucket (no SUMO);
 * only the simulate-pipeline cases need the real binary (skipIf(!SUMO)).
 *
 * Locks:
 * - 401/403 auth matrix across /api/me, /api/submissions*, comments,
 *   activate/reject/deactivate.
 * - /api/me: { author, email, uid, isAdmin } — isAdmin from opts.adminEmails
 *   vs the verified claims.email; a token without an email is never admin.
 * - /api/catalog (public): active entry_json rows only.
 * - /api/catalog/:id/stream (public): active + bucket artifact present.
 * - submissions scoping: admin all / non-admin own; status filter.
 * - detail: submission + files + comments; owner-or-admin.
 * - preview: {entry, stream}; 404 when !sim_ready / no stream; 403 foreign.
 * - comments: 201 {id}; is_admin stamped server-side; trim + 4 KB cap.
 * - activate: admin-only; requires sim_ready + entry_json + stream;
 *   pending/inactive -> active; active + no supersedes -> 200 no-op;
 *   active + supersedes -> 409; supersede target must exist + be active
 *   + != id; target flips to inactive with superseded_by.
 * - reject: admin-only, pending-only, comment required (400); thread row.
 * - deactivate: admin-only, active-only.
 * - GET /api/files access rule: no row -> public (generated ids keep
 *   working); active -> public; pending/rejected/inactive -> owner/admin.
 * - foreign same-id POST -> 403 BEFORE any bucket mutation (files intact).
 * - email notifications (recording fake opts.mailer seam): admin comment
 *   -> owner; owner comment -> all admins; self-comment/legacy rows ->
 *   nothing; reject -> ONE owner email; supersede -> OLD owner only;
 *   fire-and-forget (a rejecting mailer never changes the response).
 * - (SUMO) simulate happy path: DB row pending + sim_ready + entry_json,
 *   bucket review artifacts, NO player-dir writes; resubmit-of-active ->
 *   pending + catalog stops serving; 422 keeps sim_ready false.
 */
import { it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSimServer } from '../server.js';
import { findSumo } from '../tools/sumo_geom.js';
import * as dbStore from '../db.js';
import * as bucketStore from '../bucket.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';
import { ensureTestDb, testPool, requirePgEnv } from './helpers/pgTest.js';

const FIXDIR = path.join(PLAYER_ROOT, 'test', 'fixtures');
const ROU_XML = fs.readFileSync(path.join(FIXDIR, 'mini.rou.xml'), 'utf8');
const NET_XML = fs.readFileSync(path.join(FIXDIR, 'mini.net.xml'), 'utf8');
const SUMO = findSumo();

requirePgEnv();

const ADMIN_EMAILS = ['admin@x.test'];

/* Stream payload stored in the bucket for seeded rows (shape contract of
 * the JSONP wrapper's payload object — NOT the wrapper). */
const STREAM = {
  nFrames: 3,
  bounds: [0, 0, 100, 100],
  scenarios: { today: { frames: 'AAAAAAAAAAABAAAAAAAAAAI=' } },
};

let pool;

beforeAll(async () => {
  await ensureTestDb();
  pool = testPool();
});

beforeEach(async () => {
  await pool.query('truncate sims cascade');
});

afterAll(async () => {
  if (pool) await pool.end();
});

/* ------------------------------------------------------------- harness --- */

/* Real db.js API bound to the shared test-db pool (full mirror of the
 * server's makeDbApi). */
function dbApi() {
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

/* In-memory bucket seam twin including the review-artifact ops. */
function fakeBucketApi() {
  const objects = new Map();
  const api = {
    objects,
    async putObjects(id, files) {
      return files.map(({ name, text }) => {
        const key = bucketStore.objectKey(id, name);
        objects.set(key, Buffer.from(text));
        return {
          name, object_key: key,
          object_url: 's3://fake-bucket/' + key,
          size_bytes: Buffer.byteLength(text),
        };
      });
    },
    async putReviewArtifacts(id, arts) {
      for (const kind of ['pack', 'stream']) {
        if (arts[kind] != null) {
          objects.set(bucketStore.reviewKey(id, kind),
            Buffer.from(JSON.stringify(arts[kind])));
        }
      }
    },
    async getReviewStream(id) {
      const v = objects.get(bucketStore.reviewKey(id, 'stream'));
      return v ? JSON.parse(v.toString('utf8')) : null;
    },
    async deleteObjects(id) {
      const prefix = 'uploads/' + id + '/';
      let n = 0;
      for (const k of [...objects.keys()]) {
        if (k.startsWith(prefix)) { objects.delete(k); n++; }
      }
      return n;
    },
    async getObjectBytes(key) {
      const v = objects.get(key);
      if (!v) {
        const e = new Error('The specified key does not exist.');
        e.name = 'NoSuchKey';
        throw e;
      }
      return v;
    },
  };
  return api;
}

/* Auth seam: qa (regular), other (foreign user), admin (adminEmails
 * match), noemail (claims WITHOUT email — never admin). */
function fakeVerifyToken(token) {
  const users = {
    'tok-qa': { uid: 'qa', name: 'qa user', email: 'qa@x.test' },
    'tok-other': { uid: 'other', name: 'other user', email: 'other@x.test' },
    'tok-admin': { uid: 'admin-1', name: 'admin user',
      email: 'admin@x.test' },
    'tok-noemail': { uid: 'noemail', name: 'no email' },
  };
  if (users[token]) return users[token];
  throw new Error('bad token');
}

/* Recording mailer seam twin ({ send, baseUrl } — the createMailerFromEnv
 * return shape): every notify() pushes into `sent`; `impl` (when given)
 * lets a case reject the send to prove fire-and-forget. */
function fakeMailer(impl = null, baseUrl = null) {
  const sent = [];
  return {
    sent,
    baseUrl,
    async send(mail) {
      sent.push(mail);
      if (impl) return impl(mail);
      return undefined;
    },
  };
}

function startServer(opts = {}) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-endprev-'));
  const distDir = path.join(td, 'dist');
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(distDir, 'index.html'),
    '<!DOCTYPE html><html><body>simo endpoint review test</body></html>');
  const server = createSimServer({
    playerDir: td,
    distDir,
    rootDir: PLAYER_ROOT,
    db: opts.db || dbApi(),
    bucket: opts.bucket || fakeBucketApi(),
    verifyToken: fakeVerifyToken,
    adminEmails: ADMIN_EMAILS,
    mailer: opts.mailer || fakeMailer(),
    ...(opts.sumoResolver ? {} : { sumoResolver: () => SUMO }),
    ...opts,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, td, port, base: 'http://127.0.0.1:' + port });
    });
  });
}

/* --------------------------------------------------------------- helpers --- */

function auth(token) {
  return { Authorization: 'Bearer ' + token };
}

async function jget(base, p, token) {
  return fetch(base + p, { headers: token ? auth(token) : {} });
}

async function jpost(base, p, data, token) {
  return fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(token ? auth(token) : {}) },
    body: JSON.stringify(data),
  });
}

/* Seed a sims row through the real db.js, optionally finalized (entry_json
 * + sim_ready) and flipped to a status. Registers the stream artifact in
 * the bucket when simReady. */
async function seedSim(bucket, id, o = {}) {
  const {
    title = 'Seeded sim', author = 'qa user', authorUid = 'qa',
    authorEmail = 'qa@x.test', desc = 'seeded', simReady = false,
    status = 'pending', entry = null, withStream = true,
  } = o;
  await dbStore.putUploadRefs(pool, id, {
    title, author, desc, authorUid, authorEmail,
    anchor: [12.97, 77.72], rotation: 0,
  }, ['demand.rou.xml', 'today.net.xml'].map((name) => ({
    name, object_key: 'uploads/' + id + '/' + name,
    object_url: 's3://fake-bucket/uploads/' + id + '/' + name,
    size_bytes: 11,
  })));
  if (simReady) {
    await dbStore.finalizeSim(pool, id, {
      entryJson: entry || { id, title, author, demand: 150,
        peakServed: 90, nFrames: 3,
        scenarios: { today: { title: 'TODAY', stats: 'x' } } },
      demand: 150, peakServed: 90, hasProposed: false,
    });
    if (withStream) await bucket.putReviewArtifacts(id,
      { pack: { nFrames: 3 }, stream: STREAM });
  }
  if (status !== 'pending') {
    await dbStore.setStatus(pool, id, { status, reviewedBy: 'admin-1' });
  }
}

const created = [];

afterAll(async () => {
  for (const { server, td } of created) {
    server.close();
    fs.rmSync(td, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ /api/me --- */

it('GET /api/me: 401 without a token', async () => {
  const { base, server, td } = await startServer();
  created.push({ server, td });
  const res = await jget(base, '/api/me');
  expect(res.status).toBe(401);
});

it('GET /api/me: author/email/uid/isAdmin from the verified claims', async () => {
  const { base, server, td } = await startServer();
  created.push({ server, td });
  const qa = await (await jget(base, '/api/me', 'tok-qa')).json();
  expect(qa).toEqual({ author: 'qa user', email: 'qa@x.test', uid: 'qa',
    isAdmin: false });
  const adm = await (await jget(base, '/api/me', 'tok-admin')).json();
  expect(adm.isAdmin).toBe(true);
  // claims without an email are never admin, even with adminEmails set
  const noe = await (await jget(base, '/api/me', 'tok-noemail')).json();
  expect(noe.isAdmin).toBe(false);
  expect(noe.email).toBeNull();
});

/* --------------------------------------------------------- /api/catalog --- */

it('GET /api/catalog is public and serves only active entry_json rows', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  expect(await (await jget(base, '/api/catalog')).json()).toEqual([]);

  await seedSim(bucket, 'cat-pending', { simReady: true });
  await seedSim(bucket, 'cat-active', { simReady: true, status: 'active' });
  await seedSim(bucket, 'cat-rejected', { simReady: true,
    status: 'rejected' });

  const entries = await (await jget(base, '/api/catalog')).json();
  expect(entries.length).toBe(1);
  expect(entries[0].id).toBe('cat-active');
  expect(entries[0].title).toBe('Seeded sim');
});

it('GET /api/catalog/:id/stream: public for active rows with a stream; 404 otherwise', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  expect((await jget(base, '/api/catalog/unknown-id/stream')).status)
    .toBe(404);

  await seedSim(bucket, 'cat-str', { simReady: true });       // pending
  expect((await jget(base, '/api/catalog/cat-str/stream')).status).toBe(404);

  await dbStore.setStatus(pool, 'cat-str', { status: 'active',
    reviewedBy: 'admin-1' });
  const res = await jget(base, '/api/catalog/cat-str/stream');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/application\/json/);
  expect(await res.json()).toEqual(STREAM);

  // active but the bucket artifact is missing -> 404
  await seedSim(bucket, 'cat-noart', { simReady: true, withStream: false,
    status: 'active' });
  expect((await jget(base, '/api/catalog/cat-noart/stream')).status)
    .toBe(404);
});

it('POST /api/catalog -> 405', async () => {
  const { base, server, td } = await startServer();
  created.push({ server, td });
  const res = await fetch(base + '/api/catalog', { method: 'POST' });
  expect(res.status).toBe(405);
});

/* ---------------------------------------------------- /api/submissions --- */

it('GET /api/submissions: 401 anon; admin sees all; users see only their own', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  await seedSim(bucket, 'sub-a', {});
  await seedSim(bucket, 'sub-b', { authorUid: 'other',
    authorEmail: 'other@x.test', author: 'other user' });

  expect((await jget(base, '/api/submissions')).status).toBe(401);
  const mine = await (await jget(base, '/api/submissions', 'tok-qa')).json();
  expect(mine.map((r) => r.id)).toEqual(['sub-a']);
  const theirs = await (await jget(base, '/api/submissions',
    'tok-other')).json();
  expect(theirs.map((r) => r.id)).toEqual(['sub-b']);
  const all = await (await jget(base, '/api/submissions',
    'tok-admin')).json();
  expect(all.map((r) => r.id).sort()).toEqual(['sub-a', 'sub-b']);
});

it('GET /api/submissions?status= filters; invalid status -> 400', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  await seedSim(bucket, 'st-p', {});
  await seedSim(bucket, 'st-a', { status: 'active' });
  const pend = await (await jget(base,
    '/api/submissions?status=pending', 'tok-admin')).json();
  expect(pend.map((r) => r.id)).toEqual(['st-p']);
  const bad = await jget(base, '/api/submissions?status=bogus', 'tok-admin');
  expect(bad.status).toBe(400);
});

it('GET /api/submissions/:id: submission + files + comments; owner-or-admin', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  await seedSim(bucket, 'det-a', {});
  await dbStore.addComment(pool, 'det-a', { author: 'x', authorUid: 'u',
    isAdmin: false, body: 'note' });

  expect((await jget(base, '/api/submissions/det-unknown', 'tok-qa')).status)
    .toBe(404);
  expect((await jget(base, '/api/submissions/det-a', 'tok-other')).status)
    .toBe(403);

  const own = await (await jget(base, '/api/submissions/det-a',
    'tok-qa')).json();
  expect(own.submission.id).toBe('det-a');
  expect(own.submission.author_uid).toBe('qa');
  expect(own.files).toEqual(['demand.rou.xml', 'today.net.xml']);
  expect(own.comments.map((c) => c.body)).toEqual(['note']);

  const adm = await (await jget(base, '/api/submissions/det-a',
    'tok-admin')).json();
  expect(adm.submission.id).toBe('det-a');
});

/* ------------------------------------------------------------ preview --- */

it('GET /api/submissions/:id/preview: owner-or-admin {entry, stream}; 404s', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  await seedSim(bucket, 'pv-ready', { simReady: true });
  await seedSim(bucket, 'pv-nostream', { simReady: true, withStream: false });
  await seedSim(bucket, 'pv-notready', { simReady: false });
  await seedSim(bucket, 'pv-foreign', { authorUid: 'other', simReady: true });

  const res = await jget(base, '/api/submissions/pv-ready/preview', 'tok-qa');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.entry.id).toBe('pv-ready');
  expect(body.stream).toEqual(STREAM);

  // admin previews a foreign submission
  expect((await jget(base, '/api/submissions/pv-ready/preview',
    'tok-admin')).status).toBe(200);

  // foreign -> 403
  expect((await jget(base, '/api/submissions/pv-ready/preview',
    'tok-other')).status).toBe(403);
  // not ready -> 404
  expect((await jget(base, '/api/submissions/pv-notready/preview',
    'tok-qa')).status).toBe(404);
  // ready but no stream artifact -> 404
  expect((await jget(base, '/api/submissions/pv-nostream/preview',
    'tok-qa')).status).toBe(404);
  // unknown -> 404
  expect((await jget(base, '/api/submissions/nope/preview',
    'tok-qa')).status).toBe(404);
});

/* ------------------------------------------------------------ comments --- */

it('POST /api/submissions/:id/comments: 201 {id}, is_admin stamped server-side', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  await seedSim(bucket, 'cm-1', {});

  expect((await fetch(base + '/api/submissions/cm-1/comments',
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"body":"hi"}' })).status).toBe(401);

  const ok = await jpost(base, '/api/submissions/cm-1/comments',
    { body: '  looks good  ' }, 'tok-qa');
  expect(ok.status).toBe(201);
  const { id } = await ok.json();
  expect(typeof id).toBe('number');

  // foreign -> 403
  expect((await jpost(base, '/api/submissions/cm-1/comments',
    { body: 'hi' }, 'tok-other')).status).toBe(403);

  // empty / whitespace -> 400; > 4096 chars -> 400
  expect((await jpost(base, '/api/submissions/cm-1/comments',
    { body: '   ' }, 'tok-qa')).status).toBe(400);
  expect((await jpost(base, '/api/submissions/cm-1/comments',
    { body: 'x'.repeat(4097) }, 'tok-qa')).status).toBe(400);

  // admin comment stamped is_admin
  await jpost(base, '/api/submissions/cm-1/comments',
    { body: 'from admin' }, 'tok-admin');
  const thread = await dbStore.listComments(pool, 'cm-1');
  expect(thread.map((c) => [c.body, c.is_admin]))
    .toEqual([['looks good', false], ['from admin', true]]);
});

/* ------------------------------------------------------------ activate --- */

it('POST activate: admin-only, gated on artifacts, supersedes validation', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  await seedSim(bucket, 'ac-1', { simReady: true });
  await seedSim(bucket, 'ac-notready', {});
  await seedSim(bucket, 'ac-target', { simReady: true, status: 'active' });
  await seedSim(bucket, 'ac-rej', { simReady: true, status: 'rejected' });

  // 403 for non-admins
  expect((await jpost(base, '/api/submissions/ac-1/activate', {},
    'tok-qa')).status).toBe(403);
  // unknown id -> 404
  expect((await jpost(base, '/api/submissions/ac-unknown/activate', {},
    'tok-admin')).status).toBe(404);
  // !sim_ready / no entry_json -> 409
  expect((await jpost(base, '/api/submissions/ac-notready/activate', {},
    'tok-admin')).status).toBe(409);
  // rejected -> 409
  expect((await jpost(base, '/api/submissions/ac-rej/activate', {},
    'tok-admin')).status).toBe(409);

  // success: pending -> active
  const ok = await jpost(base, '/api/submissions/ac-1/activate', {},
    'tok-admin');
  expect(ok.status).toBe(200);
  const catalog = await (await jget(base, '/api/catalog')).json();
  expect(catalog.map((e) => e.id).sort())
    .toEqual(['ac-1', 'ac-target'].sort());

  // idempotent no-op on an active row without supersedes
  expect((await jpost(base, '/api/submissions/ac-1/activate', {},
    'tok-admin')).status).toBe(200);
  // 409 when supersedes is given for an already-active row
  expect((await jpost(base, '/api/submissions/ac-1/activate',
    { supersedes: 'ac-target' }, 'tok-admin')).status).toBe(409);

  // supersedes validation
  expect((await jpost(base, '/api/submissions/ac-rej/activate', {},
    'tok-admin')).status).toBe(409);         // still rejected -> 409
  expect((await jpost(base, '/api/submissions/ac-notready/activate',
    { supersedes: 'ac-target' }, 'tok-admin')).status).toBe(409);
  expect((await jpost(base, '/api/submissions/ac-1/activate',
    { supersedes: 'ac-1' }, 'tok-admin')).status).toBe(400);
  expect((await jpost(base, '/api/submissions/ac-1/activate',
    { supersedes: 'no-such-row' }, 'tok-admin')).status).toBe(409);
  // generated base-bundle entries have no sims row -> 409, never 500
  expect((await jpost(base, '/api/submissions/ac-1/activate',
    { supersedes: 'generated-entry-id' }, 'tok-admin')).status).toBe(409);
  // a non-active target -> 409 (rejected target)
  expect((await jpost(base, '/api/submissions/ac-1/activate',
    { supersedes: 'ac-rej' }, 'tok-admin')).status).toBe(409);

  // success WITH supersede: target flips to inactive + superseded_by
  const ok2 = await jpost(base, '/api/submissions/ac-notready/activate',
    { supersedes: 'ac-target' }, 'tok-admin');
  // ac-notready has no entry_json -> 409 even with a valid target
  expect(ok2.status).toBe(409);
  await seedSim(bucket, 'ac-good', { simReady: true });
  const ok3 = await jpost(base, '/api/submissions/ac-good/activate',
    { supersedes: 'ac-target' }, 'tok-admin');
  expect(ok3.status).toBe(200);
  const rows = await pool.query(
    'select id, status, superseded_by from sims where id in ($1,$2)',
    ['ac-good', 'ac-target']);
  const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
  expect(byId['ac-good'].status).toBe('active');
  expect(byId['ac-target'].status).toBe('inactive');
  expect(byId['ac-target'].superseded_by).toBe('ac-good');
  const after = await (await jget(base, '/api/catalog')).json();
  expect(after.map((e) => e.id)).not.toContain('ac-target');
  expect(after.map((e) => e.id)).toContain('ac-good');
});

/* reject + deactivate ------------------------------------------------------ */

it('POST reject: comment required, pending-only, admin comment lands in the thread', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  await seedSim(bucket, 'rj-1', { simReady: true });
  await seedSim(bucket, 'rj-active', { simReady: true, status: 'active' });

  expect((await jpost(base, '/api/submissions/rj-1/reject',
    { comment: 'x' }, 'tok-qa')).status).toBe(403);
  expect((await jpost(base, '/api/submissions/rj-1/reject',
    {}, 'tok-admin')).status).toBe(400);
  expect((await jpost(base, '/api/submissions/rj-1/reject',
    { comment: '   ' }, 'tok-admin')).status).toBe(400);
  expect((await jpost(base, '/api/submissions/rj-active/reject',
    { comment: 'x' }, 'tok-admin')).status).toBe(409);

  const ok = await jpost(base, '/api/submissions/rj-1/reject',
    { comment: 'double-check the demand numbers' }, 'tok-admin');
  expect(ok.status).toBe(200);
  const row = await dbStore.getSubmission(pool, 'rj-1');
  expect(row.status).toBe('rejected');
  const thread = await dbStore.listComments(pool, 'rj-1');
  expect(thread.length).toBe(1);
  expect(thread[0].is_admin).toBe(true);
  expect(thread[0].body).toBe('double-check the demand numbers');
});

it('POST deactivate: active-only, admin-only', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  await seedSim(bucket, 'dc-1', { simReady: true, status: 'active' });
  await seedSim(bucket, 'dc-p', { simReady: true });

  expect((await jpost(base, '/api/submissions/dc-p/deactivate', {},
    'tok-admin')).status).toBe(409);
  expect((await jpost(base, '/api/submissions/dc-1/deactivate', {},
    'tok-qa')).status).toBe(403);
  const ok = await jpost(base, '/api/submissions/dc-1/deactivate', {},
    'tok-admin');
  expect(ok.status).toBe(200);
  const row = await dbStore.getSubmission(pool, 'dc-1');
  expect(row.status).toBe('inactive');
  const catalog = await (await jget(base, '/api/catalog')).json();
  expect(catalog.map((e) => e.id)).toEqual([]);
});

/* ------------------------------------------------- email notifications --- */

it('comment notifications: admin comment -> owner; owner comment -> all admins', async () => {
  const mailer = fakeMailer(null, 'https://app.test');
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({
    bucket, mailer, adminEmails: ['admin@x.test', 'admin2@x.test'] });
  created.push({ server, td });
  await seedSim(bucket, 'nt-1', {});

  const ok = await jpost(base, '/api/submissions/nt-1/comments',
    { body: 'please check the demand' }, 'tok-admin');
  expect(ok.status).toBe(201);
  expect(mailer.sent.length).toBe(1);
  expect(mailer.sent[0].to).toEqual(['qa@x.test']);
  expect(mailer.sent[0].subject)
    .toBe('[OpenBengaluru] New comment on "Seeded sim"');
  expect(mailer.sent[0].text).toContain('please check the demand');
  expect(mailer.sent[0].text).toContain('View: https://app.test');

  mailer.sent.length = 0;
  await jpost(base, '/api/submissions/nt-1/comments',
    { body: 'updated the counts' }, 'tok-qa');
  expect(mailer.sent.length).toBe(1);
  expect(mailer.sent[0].to).toEqual(['admin@x.test', 'admin2@x.test']);
  expect(mailer.sent[0].text).toContain('updated the counts');
});

it('no notification for a self-comment or a legacy row (author_email null)', async () => {
  const mailer = fakeMailer();
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket, mailer });
  created.push({ server, td });
  await seedSim(bucket, 'nt-self', { authorUid: 'admin-1',
    authorEmail: 'admin@x.test' });
  await seedSim(bucket, 'nt-legacy', { authorUid: null, authorEmail: null });

  expect((await jpost(base, '/api/submissions/nt-self/comments',
    { body: 'my own sim' }, 'tok-admin')).status).toBe(201);
  expect((await jpost(base, '/api/submissions/nt-legacy/comments',
    { body: 'legacy row' }, 'tok-admin')).status).toBe(201);
  expect(mailer.sent).toEqual([]);
});

it('reject emails the owner exactly once (no second comment email)', async () => {
  const mailer = fakeMailer();
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket, mailer });
  created.push({ server, td });
  await seedSim(bucket, 'nt-rj', { simReady: true });

  const ok = await jpost(base, '/api/submissions/nt-rj/reject',
    { comment: 'double-check the demand numbers' }, 'tok-admin');
  expect(ok.status).toBe(200);
  expect(mailer.sent.length).toBe(1);
  expect(mailer.sent[0].to).toEqual(['qa@x.test']);
  expect(mailer.sent[0].subject)
    .toBe('[OpenBengaluru] "Seeded sim" was rejected');
  expect(mailer.sent[0].text).toContain('double-check the demand numbers');
});

it('supersede emails only the OLD sim owner; plain/idempotent activate sends nothing', async () => {
  const mailer = fakeMailer();
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket, mailer });
  created.push({ server, td });
  await seedSim(bucket, 'nt-old', { simReady: true, status: 'active',
    authorUid: 'other', authorEmail: 'other@x.test', author: 'other user',
    title: 'Old sim' });
  await seedSim(bucket, 'nt-new', { simReady: true, title: 'New sim' });
  await seedSim(bucket, 'nt-new2', { simReady: true, title: 'Newer sim' });
  await seedSim(bucket, 'nt-legacy-old', { simReady: true,
    status: 'active', authorUid: null, authorEmail: null });
  await seedSim(bucket, 'nt-new3', { simReady: true });

  // plain activation + idempotent retry: no email
  expect((await jpost(base, '/api/submissions/nt-new/activate', {},
    'tok-admin')).status).toBe(200);
  expect((await jpost(base, '/api/submissions/nt-new/activate', {},
    'tok-admin')).status).toBe(200);
  expect(mailer.sent).toEqual([]);

  // supersedes: the OLD sim's owner is emailed, naming the new sim id
  expect((await jpost(base, '/api/submissions/nt-new2/activate',
    { supersedes: 'nt-old' }, 'tok-admin')).status).toBe(200);
  expect(mailer.sent.length).toBe(1);
  expect(mailer.sent[0].to).toEqual(['other@x.test']);
  expect(mailer.sent[0].subject)
    .toBe('[OpenBengaluru] "Old sim" was superseded');
  expect(mailer.sent[0].text).toContain('nt-new2');

  // a supersede target without an author_email skips the email
  expect((await jpost(base, '/api/submissions/nt-new3/activate',
    { supersedes: 'nt-legacy-old' }, 'tok-admin')).status).toBe(200);
  expect(mailer.sent.length).toBe(1);
});

it('fire-and-forget: a rejecting mailer never changes the API responses', async () => {
  const mailer = fakeMailer(() => Promise.reject(new Error('smtp down')));
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket, mailer });
  created.push({ server, td });
  await seedSim(bucket, 'nt-ff', { simReady: true });

  expect((await jpost(base, '/api/submissions/nt-ff/comments',
    { body: 'hi' }, 'tok-qa')).status).toBe(201);
  expect((await jpost(base, '/api/submissions/nt-ff/reject',
    { comment: 'nope' }, 'tok-admin')).status).toBe(200);
  expect(mailer.sent.length).toBe(2);
});

/* ------------------------------------------------- files access rule --- */

it('GET /api/files: no row -> public (generated ids), active -> public, pending -> owner/admin only', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  await bucket.putObjects('fl-active', [
    { name: 'today.net.xml', text: '<net/>' }]);
  await seedSim(bucket, 'fl-active', { simReady: true, status: 'active' });
  await seedSim(bucket, 'fl-pending', {});
  await bucket.putObjects('fl-pending', [
    { name: 'today.net.xml', text: '<net/>' }]);

  // unknown id: today's public behavior is preserved
  expect((await jget(base, '/api/files/unknown-fl-id')).status).toBe(200);

  // active row: public
  expect((await jget(base, '/api/files/fl-active')).status).toBe(200);

  // pending row: anon 401, foreign 403, owner 200, admin 200
  expect((await jget(base, '/api/files/fl-pending')).status).toBe(401);
  expect((await jget(base, '/api/files/fl-pending', 'tok-other')).status)
    .toBe(403);
  expect((await jget(base, '/api/files/fl-pending', 'tok-qa')).status)
    .toBe(200);
  expect((await jget(base, '/api/files/fl-pending', 'tok-admin')).status)
    .toBe(200);
  // download route follows the same rule
  expect((await jget(base, '/api/files/fl-pending/today.net.xml')).status)
    .toBe(401);
  expect((await jget(base, '/api/files/fl-pending/today.net.xml',
    'tok-qa')).status).toBe(200);
});

/* ----------------------------------------------- foreign same-id POST --- */

it('a foreign same-id POST is 403 and does NOT touch the owner bucket files', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  await seedSim(bucket, 'own-1', {});
  await bucket.putObjects('own-1', [
    { name: 'today.net.xml', text: 'OWNER NET' },
    { name: 'demand.rou.xml', text: 'OWNER ROU' }]);
  const before = bucket.objects.get('uploads/own-1/today.net.xml').toString();
  const filesBefore = await dbStore.listUploads(pool, 'own-1');

  const res = await fetch(base + '/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      Authorization: 'Bearer tok-other' },
    body: JSON.stringify({
      id: 'own-1', title: 'hijack', author: 'x', desc: 'x',
      dataSource: 'survey_data', sourceUrl: 'https://example.test/counts',
      rouXml: ROU_XML, todayNetXml: NET_XML,
    }),
  });
  expect(res.status).toBe(403);
  // the owner's bucket files are untouched (no deleteObjects ran)
  expect(bucket.objects.get('uploads/own-1/today.net.xml').toString())
    .toBe(before);
  expect(await dbStore.listUploads(pool, 'own-1')).toEqual(filesBefore);
  const row = await dbStore.getSubmission(pool, 'own-1');
  expect(row.title).toBe('Seeded sim');
});

/* ----------------------------------------------------- simulate (SUMO) --- */

function postBody(over = {}) {
  return JSON.stringify({
    id: 'rev-happy',
    title: 'Review pipeline run',
    author: 'spoof',
    desc: 'posted from the review endpoint test',
    rouXml: ROU_XML,
    todayNetXml: NET_XML,
    anchor: [12.97, 77.72],
    rotation: 7,
    dataSource: 'survey_data',
    sourceUrl: 'https://example.test/counts',
    ...over,
  });
}

function postSim(base, data, token = 'tok-qa', extra = {}) {
  return fetch(base + '/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization:
      'Bearer ' + token },
    body: data,
    ...extra,
  });
}

it.skipIf(!SUMO)('simulate: DB row pending + sim_ready + entry_json, bucket artifacts, NO player-dir writes', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  const res = await postSim(base, postBody({ id: 'rev-happy' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: 'rev-happy' });

  const row = await dbStore.getSubmission(pool, 'rev-happy');
  expect(row.status).toBe('pending');
  expect(row.sim_ready).toBe(true);
  expect(row.author_uid).toBe('qa');
  expect(row.author_email).toBe('qa@x.test');
  expect(row.author).toBe('qa user');       // claims author, body ignored
  expect(row.demand).toBe(150);
  expect(row.entry_json.id).toBe('rev-happy');
  expect(row.entry_json.scenarios.today.geoLocked).toBe(true);
  expect(row.entry_json.anchor).toEqual([25, 25]);
  expect(row.entry_json.dataSource).toBe('survey_data');
  expect(row.entry_json.sourceUrl).toBe('https://example.test/counts');
  expect(row.reviewed_by).toBeNull();
  expect(row.superseded_by).toBeNull();

  // bucket review artifacts: stream payload (NOT the JSONP wrapper)
  const stream = await bucket.getReviewStream('rev-happy');
  expect(stream.nFrames).toBe(900);
  expect(Object.keys(stream.scenarios)).toEqual(['today']);
  expect(typeof stream.scenarios.today.frames).toBe('string');

  // no player-dir mutation at all: data.js untouched, no stream file
  expect(fs.existsSync(path.join(td, 'data.js'))).toBe(false);
  expect(fs.existsSync(path.join(td, 'streams'))).toBe(false);

  // NOT in the public catalog yet
  const catalog = await (await jget(base, '/api/catalog')).json();
  expect(catalog.map((e) => e.id)).toEqual([]);
});

it.skipIf(!SUMO)('simulate resubmit-of-active: row back to pending, catalog stops serving it', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  expect((await postSim(base, postBody({ id: 'rev-resub' }))).status)
    .toBe(200);
  await jpost(base, '/api/submissions/rev-resub/activate', {}, 'tok-admin');
  let catalog = await (await jget(base, '/api/catalog')).json();
  expect(catalog.map((e) => e.id)).toEqual(['rev-resub']);

  expect((await postSim(base, postBody({ id: 'rev-resub',
    title: 'Resubmitted' }))).status).toBe(200);
  const row = await dbStore.getSubmission(pool, 'rev-resub');
  expect(row.status).toBe('pending');
  expect(row.reviewed_by).toBeNull();
  expect(row.reviewed_at).toBeNull();
  expect(row.superseded_by).toBeNull();
  expect(row.entry_json.title).toBe('Resubmitted');
  // comment thread preserved across the resubmit (+ the system marker)
  await dbStore.addComment(pool, 'rev-resub', { author: 'admin',
    authorUid: 'admin-1', isAdmin: true, body: 'note before resubmit' });
  const comments = await dbStore.listComments(pool, 'rev-resub');
  expect(comments.length).toBe(2);
  expect(comments[0].author).toBe('system');   // resubmission marker first
  expect(comments[1].body).toBe('note before resubmit');

  const catalog2 = await (await jget(base, '/api/catalog')).json();
  expect(catalog2.map((e) => e.id)).toEqual([]);
});

it.skipIf(!SUMO)('simulate resubmit stamps a system comment on the review thread', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });

  /* fresh submission: no thread rows */
  expect((await postSim(base, postBody({ id: 'rev-resys' }))).status)
    .toBe(200);
  expect(await dbStore.listComments(pool, 'rev-resys')).toEqual([]);

  /* resubmission: exactly one system-authored marker comment */
  expect((await postSim(base, postBody({ id: 'rev-resys' }))).status)
    .toBe(200);
  const comments = await dbStore.listComments(pool, 'rev-resys');
  expect(comments.length).toBe(1);
  expect(comments[0].author).toBe('system');
  expect(comments[0].author_uid).toBe('system');
  expect(comments[0].is_admin).toBe(false);
  expect(comments[0].body).toMatch(/resubmit/i);

  /* a second resubmission appends another marker (not replaces) */
  expect((await postSim(base, postBody({ id: 'rev-resys' }))).status)
    .toBe(200);
  expect((await dbStore.listComments(pool, 'rev-resys')).length).toBe(2);
});

it.skipIf(!SUMO)('422 pipeline failure: row + sources persist, sim_ready stays false', async () => {
  const bucket = fakeBucketApi();
  const { base, server, td } = await startServer({ bucket });
  created.push({ server, td });
  const res = await postSim(base, postBody({
    id: 'rev-422',
    todayNetXml: '<not-a-net>this is garbage</not-a-net>',
  }));
  expect(res.status).toBe(422);
  const row = await dbStore.getSubmission(pool, 'rev-422');
  expect(row).toBeTruthy();
  expect(row.status).toBe('pending');
  expect(row.sim_ready).toBe(false);
  expect(row.entry_json).toBeNull();
  const list = await (await jget(base, '/api/files/rev-422',
    'tok-qa')).json();
  expect(list).toEqual(['demand.rou.xml', 'today.net.xml']);
});