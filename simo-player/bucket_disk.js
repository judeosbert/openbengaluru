/* Disk-backed bucket storage for dev: a local directory playing the role
 * of the S3-compatible bucket, as a { bucket, send } seam twin — the
 * UNCHANGED bucket.js ops (putObjects / deleteObjects / getObjectBytes /
 * putReviewArtifacts / getReviewStream) run on it unchanged. Selected by
 * createBucketFromEnv when SIMO_BUCKET_DISK_DIR is set (dev convenience:
 * no SIMO_S3_* creds needed); the real server keeps using S3 otherwise.
 *
 * Server-side module — repo root, NOT src/lib, mirroring bucket.js. Keys
 * map 1:1 to paths under the root (uploads/<id>/<name> ->
 * <root>/uploads/<id>/<name>); send() re-guards every key (no absolute,
 * '..', '.', empty or backslash segments) and resolves strictly inside the
 * root, even though the only callers build keys through bucket.js's
 * objectKey/reviewKey guards. Missing reads throw name='NoSuchKey' so
 * getReviewStream's missing-artifact contract holds byte-for-byte.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

export const DISK_DIR_VAR = 'SIMO_BUCKET_DISK_DIR';

/* createDiskBucketFromEnv: fail fast naming the var (no defaults), same
 * style as createS3FromEnv's missing-vars report. */
export function createDiskBucketFromEnv(env = process.env) {
  const dir = env[DISK_DIR_VAR];
  if (!dir) {
    throw new Error('missing env: ' + DISK_DIR_VAR
      + ' — set it to a local directory for disk-backed bucket storage '
      + '(dev; unset it to use SIMO_S3_*)');
  }
  return createDiskBucket(dir);
}

/* send() command dispatch is instanceof against the same SDK classes
 * bucket.js constructs — the seam twin accepts exactly what the ops send. */

function noSuchKey(key) {
  const e = new Error('NoSuchKey: ' + key);
  e.name = 'NoSuchKey';
  return e;
}

export function createDiskBucket(dir) {
  if (typeof dir !== 'string' || !dir.trim()) {
    throw new Error('invalid bucket dir: ' + String(dir));
  }
  const root = path.resolve(dir);
  /* Key guard — independent of bucket.js's key builders (defense in
   * depth): a legal key has no empty/'.'/'..' segment, no backslash, no
   * absolute form. The resolved path must stay inside the root. */
  const safePath = (key) => {
    if (typeof key !== 'string' || !key.length || key.startsWith('/')
      || key.includes('\\')
      || key.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error('invalid key: ' + JSON.stringify(key));
    }
    const fp = path.resolve(root, key);
    if (fp !== root && !fp.startsWith(root + path.sep)) {
      throw new Error('invalid key: ' + JSON.stringify(key));
    }
    return fp;
  };
  /* recursive flat walk (ListObjectsV2 semantics: the prefix space is
   * flat — review/ nested keys surface in the same listing) */
  const walkFiles = (dir, acc) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) walkFiles(fp, acc);
      else if (ent.isFile()) acc.push(fp);
    }
  };
  const send = async (cmd) => {
    if (cmd instanceof PutObjectCommand) {
      const fp = safePath(cmd.input.Key);
      const body = cmd.input.Body;
      const buf = Buffer.isBuffer(body) ? body
        : body instanceof Uint8Array ? Buffer.from(body)
        : Buffer.from(String(body ?? ''));
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, buf);
      return {};
    }
    if (cmd instanceof GetObjectCommand) {
      const fp = safePath(cmd.input.Key);
      let buf;
      try {
        buf = fs.readFileSync(fp);
      } catch (e) {
        if (e && e.code === 'ENOENT') throw noSuchKey(cmd.input.Key);
        throw e;
      }
      return { Body: buf };
    }
    if (cmd instanceof ListObjectsV2Command) {
      const prefix = String(cmd.input.Prefix || '');
      const dirKey = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
      const base = dirKey ? safePath(dirKey) : root;
      const files = [];
      walkFiles(base, files);
      const contents = files
        .map((fp) => path.relative(root, fp).split(path.sep).join('/'))
        .filter((k) => k.startsWith(prefix))
        .sort()
        .map((k) => ({ Key: k }));
      return contents.length ? { Contents: contents } : {};
    }
    if (cmd instanceof DeleteObjectsCommand) {
      const objects = (cmd.input.Delete && cmd.input.Delete.Objects) || [];
      /* S3 deletes of absent keys succeed — force:true mirrors that */
      for (const { Key } of objects) fs.rmSync(safePath(Key), { force: true });
      return { Deleted: objects.map(({ Key }) => ({ Key })) };
    }
    throw new Error('unsupported command: '
      + (cmd && cmd.constructor ? cmd.constructor.name : String(cmd)));
  };
  return {
    /* bucket name = the resolved root dir — object_url in the sim_files
     * refs ('s3://<bucket>/<key>') stays a meaningful pointer on disk */
    bucket: root,
    send,
  };
}