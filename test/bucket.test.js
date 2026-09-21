/* bucket.js unit tests — key-building guards + the fake-client seam the
 * server and endpoint tests inject (real S3 only behind the opt-in
 * SIMO_TEST_S3_REAL=1, per plan; no MinIO docker default). Locks: object
 * keys built ONLY from the fixed FILE_NAMES constants + an ID_RE-validated
 * id, createS3FromEnv fail-fast listing missing SIMO_S3_* vars, putObjects
 * returning the exact DB ref shape, deleteObjects list-then-batch,
 * getObjectBytes draining the Body to bytes. The capture storage ops
 * (captureKey + putCaptureObject, plan: capture-leaderboard page) live
 * under their own captures/<id>/ prefix — never uploads/<id>/.
 */
import { it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  ID_RE, FILE_NAMES, objectKey, reviewKey, captureKey, createS3FromEnv,
  putObjects, deleteObjects, getObjectBytes,
  putReviewArtifacts, getReviewStream, putCaptureObject,
  deleteCaptureObjects,
} from '../bucket.js';

/* ------------------------------------------------------------- constants --- */

it('FILE_NAMES + ID_RE carry the upload-name contract (storage.js port)', () => {
  expect(FILE_NAMES).toEqual({
    todayNet: 'today.net.xml',
    proposedNet: 'proposed.net.xml',
    demand: 'demand.rou.xml',
  });
  for (const ok of ['endp-happy', 'a1', 'my-sim-2026']) {
    expect(ID_RE.test(ok), JSON.stringify(ok)).toBe(true);
  }
  for (const bad of ['', '../evil', 'a/b', 'UPPER', '-lead', 'a b', '.dot']) {
    expect(ID_RE.test(bad), JSON.stringify(bad)).toBe(false);
  }
});

/* ------------------------------------------------------------ key guards --- */

it('objectKey builds uploads/<id>/<name> only from validated parts', () => {
  expect(objectKey('bkt-1', 'today.net.xml'))
    .toBe('uploads/bkt-1/today.net.xml');
  for (const name of Object.values(FILE_NAMES)) {
    expect(objectKey('a1', name)).toBe('uploads/a1/' + name);
  }
  for (const bad of ['', '../evil', 'UPPER', '-lead', 'a b', '.dot', null]) {
    expect(() => objectKey(bad, 'today.net.xml'), JSON.stringify(bad))
      .toThrow(/invalid id/);
  }
  /* names are whitelisted to the three fixed constants — stricter than the
   * route-level validName check, so request-supplied strings never reach a
   * key, even through future callers */
  for (const bad of ['../secret', 'other.xml', '.hidden', 'a/b', 'a\\b',
    '', null, undefined, 42]) {
    expect(() => objectKey('a1', bad), JSON.stringify(bad))
      .toThrow(/invalid name/);
  }
});

/* ---------------------------------------------------------- env factory --- */

const S3_KEYS = ['SIMO_S3_ENDPOINT', 'SIMO_S3_REGION', 'SIMO_S3_BUCKET',
  'SIMO_S3_ACCESS_KEY_ID', 'SIMO_S3_SECRET_ACCESS_KEY'];

function withEnv(over, fn) {
  const saved = S3_KEYS.map((k) => [k, process.env[k]]);
  try {
    for (const k of S3_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(over)) process.env[k] = v;
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const FULL_S3_ENV = {
  SIMO_S3_REGION: 'us-east-1',
  SIMO_S3_BUCKET: 'dev-bucket',
  SIMO_S3_ACCESS_KEY_ID: 'akid',
  SIMO_S3_SECRET_ACCESS_KEY: 'secret',
};

it('createS3FromEnv fails fast listing missing SIMO_S3_* vars', () => {
  withEnv({}, () => {
    let msg = null;
    try {
      createS3FromEnv();
    } catch (e) {
      msg = String((e && e.message) || e);
    }
    expect(msg, 'must throw on missing env').toBeTruthy();
    for (const k of ['SIMO_S3_REGION', 'SIMO_S3_BUCKET',
      'SIMO_S3_ACCESS_KEY_ID', 'SIMO_S3_SECRET_ACCESS_KEY']) {
      expect(msg).toContain(k);
    }
  });
});

it('createS3FromEnv with env set returns the { bucket, send } seam', () => {
  withEnv(FULL_S3_ENV, () => {
    const s3 = createS3FromEnv();
    expect(s3.bucket).toBe('dev-bucket');
    expect(typeof s3.send).toBe('function');
    /* SIMO_S3_ENDPOINT unset -> AWS default; when set, forcePathStyle
     * (MinIO compat) is a one-line config arg covered in review, not
     * asserted against SDK internals here */
  });
});

/* --------------------------------------------------- fake-client seam ops --- */

/* Minimal seam twin: { bucket, send(cmd) } — matches the createS3FromEnv
 * return shape. Handlers keyed by command class name; default {}. */
function fakeS3(handlers = {}) {
  const sent = [];
  return {
    bucket: 'fake-bkt',
    sent,
    send: async (cmd) => {
      sent.push(cmd);
      const h = handlers[cmd.constructor.name];
      if (h) {
        const r = h(cmd.input);
        if (r !== undefined) return r;
      }
      return {};
    },
  };
}

it('putObjects sends one PutObject per file and returns the DB ref shape', async () => {
  const s3 = fakeS3();
  const refs = await putObjects(s3, 'bkt-put', [
    { name: 'today.net.xml', text: '<net/>' },
    { name: 'demand.rou.xml', text: '<routes/>' },
  ]);
  expect(s3.sent.length).toBe(2);
  expect(s3.sent[0].input).toEqual({
    Bucket: 'fake-bkt',
    Key: 'uploads/bkt-put/today.net.xml',
    Body: '<net/>',
  });
  expect(refs).toEqual([
    {
      name: 'today.net.xml',
      object_key: 'uploads/bkt-put/today.net.xml',
      object_url: 's3://fake-bkt/uploads/bkt-put/today.net.xml',
      size_bytes: 6,
    },
    {
      name: 'demand.rou.xml',
      object_key: 'uploads/bkt-put/demand.rou.xml',
      object_url: 's3://fake-bkt/uploads/bkt-put/demand.rou.xml',
      size_bytes: 9,
    },
  ]);
});

it('putObjects rejects invalid ids before any SDK call', async () => {
  const s3 = fakeS3();
  await expect(putObjects(s3, '../evil',
    [{ name: 'today.net.xml', text: 'x' }])).rejects.toThrow(/invalid id/);
  expect(s3.sent).toEqual([]);
});

it('deleteObjects lists the id prefix then batch-deletes those keys', async () => {
  const s3 = fakeS3({
    ListObjectsV2Command: () => ({
      Contents: [
        { Key: 'uploads/bkt-del/today.net.xml' },
        { Key: 'uploads/bkt-del/demand.rou.xml' },
      ],
    }),
  });
  await deleteObjects(s3, 'bkt-del');
  expect(s3.sent.length).toBe(2);
  expect(s3.sent[0].input.Bucket).toBe('fake-bkt');
  expect(s3.sent[0].input.Prefix).toBe('uploads/bkt-del/');
  expect(s3.sent[1].input).toEqual({
    Bucket: 'fake-bkt',
    Delete: {
      Objects: [
        { Key: 'uploads/bkt-del/today.net.xml' },
        { Key: 'uploads/bkt-del/demand.rou.xml' },
      ],
    },
  });
});

it('deleteObjects with nothing listed sends no delete', async () => {
  const s3 = fakeS3({ ListObjectsV2Command: () => ({}) });
  await deleteObjects(s3, 'bkt-empty');
  expect(s3.sent.length).toBe(1);
});

it('deleteObjects rejects invalid ids before any SDK call', async () => {
  const s3 = fakeS3();
  await expect(deleteObjects(s3, '../evil')).rejects.toThrow(/invalid id/);
  expect(s3.sent).toEqual([]);
});

it('getObjectBytes drains the Body stream / buffer to bytes', async () => {
  const streamed = fakeS3({
    GetObjectCommand: () => ({
      Body: Readable.from([Buffer.from('hel'), Buffer.from('lo')]),
    }),
  });
  expect((await getObjectBytes(streamed, 'uploads/k/today.net.xml'))
    .toString()).toBe('hello');
  const buffered = fakeS3({
    GetObjectCommand: () => ({ Body: Buffer.from('raw') }),
  });
  expect((await getObjectBytes(buffered, 'uploads/k/today.net.xml'))
    .toString()).toBe('raw');
});

/* ------------------------------------------------- opt-in real bucket run --- */

const REAL = process.env.SIMO_TEST_S3_REAL && process.env.SIMO_S3_BUCKET;

it.skipIf(!REAL)('real bucket round-trip (opt-in: SIMO_TEST_S3_REAL=1 + SIMO_S3_*)', async () => {
  const s3 = createS3FromEnv();
  const id = 'bkt-real-' + Math.random().toString(36).slice(2, 8);
  const text = '<net>real</net>';
  const refs = await putObjects(s3, id, [{ name: 'today.net.xml', text }]);
  expect(refs[0].size_bytes).toBe(Buffer.byteLength(text));
  const buf = await getObjectBytes(s3, refs[0].object_key);
  expect(buf.toString()).toBe(text);
  await deleteObjects(s3, id);
  await expect(getObjectBytes(s3, refs[0].object_key)).rejects.toThrow();
});

/* ------------------------------------------------------ review artifacts --- */
/* Review pipeline artifacts (pack provenance + the playable stream payload)
 * live under uploads/<id>/review/ — NOT sim_files rows (internal
 * artifacts; the sim_files name CHECK stays as-is). Same guard style as
 * objectKey: fixed kinds + ID_RE-validated id. */

it('reviewKey builds uploads/<id>/review/<kind>.json only from validated parts', () => {
  expect(reviewKey('bkt-rev', 'pack')).toBe('uploads/bkt-rev/review/pack.json');
  expect(reviewKey('bkt-rev', 'stream')).toBe('uploads/bkt-rev/review/stream.json');
  for (const bad of ['other', '../evil', '.hidden', 'a/b', '', null, 42]) {
    expect(() => reviewKey('bkt-rev', bad), JSON.stringify(bad))
      .toThrow(/invalid kind/);
  }
  for (const bad of ['', '../evil', 'UPPER', '-lead', 'a b']) {
    expect(() => reviewKey(bad, 'pack'), JSON.stringify(bad))
      .toThrow(/invalid id/);
  }
});

it('putReviewArtifacts stores pack + stream JSON under the review prefix', async () => {
  const s3 = fakeS3();
  await putReviewArtifacts(s3, 'bkt-rev-put',
    { pack: { nFrames: 2 }, stream: { nFrames: 2, scenarios: {} } });
  const puts = s3.sent.filter(
    (c) => c.constructor.name === 'PutObjectCommand');
  expect(puts.length).toBe(2);
  expect(puts[0].input).toEqual({
    Bucket: 'fake-bkt', Key: 'uploads/bkt-rev-put/review/pack.json',
    Body: '{"nFrames":2}',
  });
  expect(puts[1].input.Key).toBe('uploads/bkt-rev-put/review/stream.json');
  expect(JSON.parse(puts[1].input.Body))
    .toEqual({ nFrames: 2, scenarios: {} });
  // invalid id never reaches the SDK
  await expect(putReviewArtifacts(s3, '../evil', { stream: {} }))
    .rejects.toThrow(/invalid id/);
  expect(s3.sent.length).toBe(2);
});

it('putReviewArtifacts skips a missing pack (stream-only contract)', async () => {
  const s3 = fakeS3();
  await putReviewArtifacts(s3, 'bkt-rev-sonly',
    { stream: { nFrames: 1, scenarios: {} } });
  expect(s3.sent.length).toBe(1);
  expect(s3.sent[0].input.Key).toBe('uploads/bkt-rev-sonly/review/stream.json');
});

it('getReviewStream returns the stored payload JSON or null when missing', async () => {
  const s3 = fakeS3({
    GetObjectCommand: (input) => {
      if (input.Key === 'uploads/bkt-rev-get/review/stream.json') {
        return { Body: Buffer.from('{"nFrames":3,"scenarios":{"today":{}}}') };
      }
      const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e;
    },
  });
  const payload = await getReviewStream(s3, 'bkt-rev-get');
  expect(payload).toEqual({ nFrames: 3, scenarios: { today: {} } });
  // missing object -> null (NoSuchKey), anything else propagates
  expect(await getReviewStream(s3, 'bkt-rev-none')).toBeNull();
});

it('getReviewStream surfaces non-NoSuchKey errors', async () => {
  const s3 = fakeS3({
    GetObjectCommand: () => { throw new Error('network down'); },
  });
  await expect(getReviewStream(s3, 'bkt-rev-err'))
    .rejects.toThrow(/network down/);
});

/* -------------------------------------------------------- capture uploads --- */
/* Capture uploads (plan: capture-leaderboard page): commuter clips/photos
 * live under captures/<id>/<name> — deliberately NOT uploads/<id>/ (a
 * simulate resubmit's deleteObjects prefix-delete must never touch them).
 * The name is server-built <id>_<junction-slug>.<ext>; same guard style as
 * objectKey (ID_RE id; no slashes, no leading dots in the name). */

it('captureKey builds captures/<id>/<name> only from validated parts', () => {
  expect(captureKey('cap-1', 'cap-1_silk-board.mp4'))
    .toBe('captures/cap-1/cap-1_silk-board.mp4');
  expect(captureKey('cap-1', 'x.mp4').startsWith('uploads/')).toBe(false);
  for (const bad of ['', '../evil', 'UPPER', '-lead', 'a b', '.dot', null]) {
    expect(() => captureKey(bad, 'x.mp4'), JSON.stringify(bad))
      .toThrow(/invalid id/);
  }
  for (const bad of ['../evil', 'a/b', 'a\\b', '.hidden', '', null,
    undefined, 42]) {
    expect(() => captureKey('cap-1', bad), JSON.stringify(bad))
      .toThrow(/invalid name/);
  }
});

it('putCaptureObject sends one PutObject (ContentType) and the DB ref shape',
  async () => {
    const s3 = fakeS3();
    const bytes = Buffer.from('fake-clip-bytes');
    const ref = await putCaptureObject(s3, 'cap-put', {
      name: 'cap-put_silk-board.mp4', contentType: 'video/mp4', bytes,
    });
    expect(s3.sent.length).toBe(1);
    expect(s3.sent[0].input).toEqual({
      Bucket: 'fake-bkt',
      Key: 'captures/cap-put/cap-put_silk-board.mp4',
      Body: bytes,
      ContentType: 'video/mp4',
    });
    expect(ref).toEqual({
      name: 'cap-put_silk-board.mp4',
      object_key: 'captures/cap-put/cap-put_silk-board.mp4',
      object_url: 's3://fake-bkt/captures/cap-put/cap-put_silk-board.mp4',
      size_bytes: bytes.length,
    });
  });

it('putCaptureObject rejects invalid ids before any SDK call', async () => {
  const s3 = fakeS3();
  await expect(putCaptureObject(s3, '../evil', {
    name: 'x.mp4', contentType: 'video/mp4', bytes: Buffer.alloc(1),
  })).rejects.toThrow(/invalid id/);
  expect(s3.sent).toEqual([]);
});

/* ------------------------------------------- capture moderation (hard delete) --- */
/* Reject = hard delete: list everything under captures/<id>/ then
 * batch-delete — the captures/ twin of deleteObjects (never uploads/, a
 * simulate resubmit's prefix-delete must not touch captures). */

it('deleteCaptureObjects lists the captures/<id>/ prefix then batch-deletes',
  async () => {
    const s3 = fakeS3({
      ListObjectsV2Command: () => ({
        Contents: [
          { Key: 'captures/cap-del/cap-del_a-junction.mp4' },
          { Key: 'captures/cap-del/extra.bin' },
        ],
      }),
    });
    const n = await deleteCaptureObjects(s3, 'cap-del');
    expect(n).toBe(2);
    expect(s3.sent.length).toBe(2);
    expect(s3.sent[0].input.Bucket).toBe('fake-bkt');
    expect(s3.sent[0].input.Prefix).toBe('captures/cap-del/');
    expect(s3.sent[1].input).toEqual({
      Bucket: 'fake-bkt',
      Delete: {
        Objects: [
          { Key: 'captures/cap-del/cap-del_a-junction.mp4' },
          { Key: 'captures/cap-del/extra.bin' },
        ],
      },
    });
  });

it('deleteCaptureObjects with nothing listed sends no delete (count 0)',
  async () => {
    const s3 = fakeS3({ ListObjectsV2Command: () => ({}) });
    expect(await deleteCaptureObjects(s3, 'cap-empty')).toBe(0);
    expect(s3.sent.length).toBe(1);
  });

it('deleteCaptureObjects rejects invalid ids before any SDK call', async () => {
  const s3 = fakeS3();
  await expect(deleteCaptureObjects(s3, '../evil'))
    .rejects.toThrow(/invalid id/);
  expect(s3.sent).toEqual([]);
});