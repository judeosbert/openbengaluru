/* bucket_disk.js tests — the disk-backed dev bucket: a real-filesystem
 * implementation of the { bucket, send } seam so createBucketFromEnv can
 * hand it to the UNCHANGED bucket.js ops (putObjects / deleteObjects /
 * getObjectBytes / putReviewArtifacts / getReviewStream). Locks: the
 * fail-fast on a missing SIMO_BUCKET_DISK_DIR, the exact DB ref shape with
 * the root dir as the bucket name, S3-compatible list-then-batch-delete
 * (recursive — nested review/ keys count), NoSuchKey mapping for missing
 * reads, path-escape guards in send, and the createBucketFromEnv dispatch
 * (disk wins over SIMO_S3_*, S3 fail-fast otherwise).
 */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createDiskBucketFromEnv, createDiskBucket } from '../bucket_disk.js';
import {
  createBucketFromEnv,
  putObjects, deleteObjects, getObjectBytes,
  putReviewArtifacts, getReviewStream,
  putCaptureObject, deleteCaptureObjects,
} from '../bucket.js';

/* Fresh per-test bucket root in the OS tempdir (real fs, no mocks). */
function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'simo-disk-'));
}

function rmRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

/* Relative slash keys of every file under root — the on-disk tree assert. */
function treeKeys(root) {
  const acc = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(fp);
      else acc.push(path.relative(root, fp).split(path.sep).join('/'));
    }
  })(root);
  return acc.sort();
}

/* --------------------------------------------------------------- env factory */

const ENV_KEYS = ['SIMO_BUCKET_DISK_DIR', 'SIMO_S3_ENDPOINT',
  'SIMO_S3_REGION', 'SIMO_S3_BUCKET', 'SIMO_S3_ACCESS_KEY_ID',
  'SIMO_S3_SECRET_ACCESS_KEY'];

function withEnv(over, fn) {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]]);
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(over)) process.env[k] = v;
    return fn();
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

it('createDiskBucketFromEnv fails fast naming SIMO_BUCKET_DISK_DIR', () => {
  withEnv({}, () => {
    let msg = null;
    try {
      createDiskBucketFromEnv();
    } catch (e) {
      msg = String((e && e.message) || e);
    }
    expect(msg, 'must throw on missing env').toBeTruthy();
    expect(msg).toContain('SIMO_BUCKET_DISK_DIR');
  });
});

it('createDiskBucketFromEnv returns the { bucket, send } seam rooted at the resolved dir', () => {
  withEnv({ SIMO_BUCKET_DISK_DIR: '/tmp/simo-disk-seam' }, () => {
    const b = createDiskBucketFromEnv();
    expect(b.bucket).toBe(path.resolve('/tmp/simo-disk-seam'));
    expect(typeof b.send).toBe('function');
  });
  /* a relative dir resolves against the process cwd (npm start runs from
   * the repo root) */
  withEnv({ SIMO_BUCKET_DISK_DIR: '.simo-uploads' }, () => {
    expect(createDiskBucketFromEnv().bucket)
      .toBe(path.resolve('.simo-uploads'));
  });
});

/* --------------------------------------------------- the interface contract --- */
/* The disk client is exercised through the REAL bucket.js high-level ops —
 * those five functions are the interface the server consumes. */

it('putObjects writes files under the root, returns the exact DB ref shape, and getObjectBytes reads them back', async () => {
  const root = freshRoot();
  try {
    const b = createDiskBucket(root);
    const refs = await putObjects(b, 'disk-put', [
      { name: 'today.net.xml', text: '<net/>' },
      { name: 'demand.rou.xml', text: '<routes/>' },
    ]);
    expect(refs).toEqual([
      {
        name: 'today.net.xml',
        object_key: 'uploads/disk-put/today.net.xml',
        object_url: 's3://' + path.resolve(root)
          + '/uploads/disk-put/today.net.xml',
        size_bytes: 6,
      },
      {
        name: 'demand.rou.xml',
        object_key: 'uploads/disk-put/demand.rou.xml',
        object_url: 's3://' + path.resolve(root)
          + '/uploads/disk-put/demand.rou.xml',
        size_bytes: 9,
      },
    ]);
    expect(treeKeys(root)).toEqual([
      'uploads/disk-put/demand.rou.xml',
      'uploads/disk-put/today.net.xml',
    ]);
    expect(fs.readFileSync(
      path.join(root, 'uploads/disk-put/today.net.xml'), 'utf8'))
      .toBe('<net/>');
    expect((await getObjectBytes(b, refs[0].object_key)).toString())
      .toBe('<net/>');
  } finally {
    rmRoot(root);
  }
});

it('deleteObjects lists recursively (nested review keys included), batch-deletes, and counts; getReviewStream maps missing to null', async () => {
  const root = freshRoot();
  try {
    const b = createDiskBucket(root);
    await putObjects(b, 'disk-del', [
      { name: 'today.net.xml', text: '<net/>' },
      { name: 'demand.rou.xml', text: '<routes/>' },
    ]);
    const stream = { nFrames: 3, scenarios: { today: {} } };
    await putReviewArtifacts(b, 'disk-del',
      { pack: { nFrames: 3 }, stream });
    expect(treeKeys(root)).toEqual([
      'uploads/disk-del/demand.rou.xml',
      'uploads/disk-del/review/pack.json',
      'uploads/disk-del/review/stream.json',
      'uploads/disk-del/today.net.xml',
    ]);
    /* the playable stream round-trips BEFORE deletion */
    expect(await getReviewStream(b, 'disk-del')).toEqual(stream);
    /* 4 objects: 2 sources + 2 nested review artifacts — a flat (non-
     * recursive) list would miss the review/ subtree */
    expect(await deleteObjects(b, 'disk-del')).toBe(4);
    expect(treeKeys(root)).toEqual([]);
    await expect(getObjectBytes(b, 'uploads/disk-del/today.net.xml'))
      .rejects.toThrow();
    /* missing stream -> null (the NoSuchKey contract) */
    expect(await getReviewStream(b, 'disk-del')).toBeNull();
    /* nothing left -> list comes back empty, no delete command queued */
    expect(await deleteObjects(b, 'disk-del')).toBe(0);
  } finally {
    rmRoot(root);
  }
});

it('putObjects rejects invalid ids before touching the filesystem', async () => {
  const root = freshRoot();
  try {
    const b = createDiskBucket(root);
    await expect(putObjects(b, '../evil',
      [{ name: 'today.net.xml', text: 'x' }])).rejects.toThrow(/invalid id/);
    expect(treeKeys(root)).toEqual([]);
  } finally {
    rmRoot(root);
  }
});

it('deleteCaptureObjects removes only captures/<id>/ — uploads/ stay intact',
  async () => {
    const root = freshRoot();
    try {
      const b = createDiskBucket(root);
      await putObjects(b, 'disk-cap', [
        { name: 'today.net.xml', text: '<net/>' },
      ]);
      await putCaptureObject(b, 'disk-cap', {
        name: 'disk-cap_a-junction.mp4', contentType: 'video/mp4',
        bytes: Buffer.from('clip'),
      });
      expect(treeKeys(root)).toEqual([
        'captures/disk-cap/disk-cap_a-junction.mp4',
        'uploads/disk-cap/today.net.xml',
      ]);
      expect(await deleteCaptureObjects(b, 'disk-cap')).toBe(1);
      /* the capture subtree is gone; the sim uploads are untouched (a
       * resubmit's deleteObjects must never reach into captures/ and the
       * reverse) */
      expect(treeKeys(root)).toEqual(['uploads/disk-cap/today.net.xml']);
      expect(await deleteCaptureObjects(b, 'disk-cap')).toBe(0);
    } finally {
      rmRoot(root);
    }
  });

/* --------------------------------------------------------------- send guards */

it('send rejects path escapes before any write and maps missing reads to NoSuchKey', async () => {
  const root = freshRoot();
  try {
    const b = createDiskBucket(root);
    for (const key of ['../escape.txt', 'a//b', '/abs.txt', 'a\\b',
      './dot', 'uploads/../escape.xml']) {
      let msg = null;
      try {
        await b.send(new PutObjectCommand({
          Bucket: b.bucket, Key: key, Body: 'x',
        }));
      } catch (e) {
        msg = String((e && e.message) || e);
      }
      expect(msg, JSON.stringify(key)).toBeTruthy();
      expect(msg, JSON.stringify(key)).toMatch(/invalid key/);
    }
    /* nothing landed inside or outside the root */
    expect(treeKeys(root)).toEqual([]);
    expect(fs.existsSync(path.resolve(root, '..', 'escape.txt'))).toBe(false);
    let err = null;
    try {
      await b.send(new GetObjectCommand({
        Bucket: b.bucket, Key: 'uploads/none/today.net.xml',
      }));
    } catch (e) {
      err = e;
    }
    expect(err, 'missing object must throw').toBeTruthy();
    expect(err.name).toBe('NoSuchKey');
  } finally {
    rmRoot(root);
  }
});

/* ------------------------------------------------------------ env dispatch --- */

it('createBucketFromEnv prefers the disk backend when SIMO_BUCKET_DISK_DIR is set, even with SIMO_S3_* present', async () => {
  const root = freshRoot();
  try {
    await withEnv({
      SIMO_BUCKET_DISK_DIR: root,
      ...FULL_S3_ENV,
    }, async () => {
      const b = createBucketFromEnv();
      expect(b.bucket).toBe(path.resolve(root));
      /* and the dispatched client complies with the real interface */
      const refs = await putObjects(b, 'disk-dispatch',
        [{ name: 'today.net.xml', text: '<net/>' }]);
      expect(treeKeys(root))
        .toEqual(['uploads/disk-dispatch/today.net.xml']);
      expect(refs[0].object_key).toBe('uploads/disk-dispatch/today.net.xml');
    });
  } finally {
    rmRoot(root);
  }
});

it('createBucketFromEnv falls back to S3 when only SIMO_S3_* is configured', () => {
  withEnv(FULL_S3_ENV, () => {
    const b = createBucketFromEnv();
    expect(b.bucket).toBe('dev-bucket');
    expect(typeof b.send).toBe('function');
  });
});

it('createBucketFromEnv fails fast listing the SIMO_S3_* vars when neither backend is configured', () => {
  withEnv({}, () => {
    let msg = null;
    try {
      createBucketFromEnv();
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