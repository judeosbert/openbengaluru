/* Bucket storage for the wizard's raw XMLs: an S3-compatible bucket
 * (env-configured) holds the bytes; Postgres (db.js) holds only references.
 * Server-side module — repo root, NOT src/lib (that layer must stay
 * DOM-free; this one is deliberately net-heavy).
 *
 * Object keys: uploads/<id>/<name> — built ONLY from the fixed FILE_NAMES
 * constants plus an ID_RE-validated id, never from request-supplied strings
 * (mirror of the retired fs storage's pre-path.join guard). The bucket
 * stays private: the server proxies downloads; creds never leave the
 * process or appear in logs.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

/* Same slug contract as server.js validateBody — the one source of truth
 * for what a legal entry id is. */
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/* Stored filenames are fixed constants generated here — the browser never
 * names them; GET /api/files/:id listing is the discovery contract. */
export const FILE_NAMES = {
  todayNet: 'today.net.xml',
  proposedNet: 'proposed.net.xml',
  demand: 'demand.rou.xml',
};

const S3_VARS = ['SIMO_S3_REGION', 'SIMO_S3_BUCKET',
  'SIMO_S3_ACCESS_KEY_ID', 'SIMO_S3_SECRET_ACCESS_KEY'];

function validId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error('invalid id');
  }
  return id;
}

/* Key builder — the ONLY place keys are constructed: fixed constants plus
 * an ID_RE-validated id, both checked BEFORE any SDK call. */
export function objectKey(id, name) {
  validId(id);
  if (!Object.values(FILE_NAMES).includes(name)) {
    throw new Error('invalid name');
  }
  return 'uploads/' + id + '/' + name;
}

/* createS3FromEnv: fail fast listing missing SIMO_S3_* vars (no defaults).
 * SIMO_S3_ENDPOINT unset/empty -> AWS; set -> path-style (MinIO compat). */
export function createS3FromEnv(env = process.env) {
  const missing = S3_VARS.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error('missing env: ' + missing.join(', ')
      + ' — set SIMO_S3_* (see .env.example)');
  }
  const endpoint = env.SIMO_S3_ENDPOINT;
  const client = new S3Client({
    region: env.SIMO_S3_REGION,
    credentials: {
      accessKeyId: env.SIMO_S3_ACCESS_KEY_ID,
      secretAccessKey: env.SIMO_S3_SECRET_ACCESS_KEY,
    },
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
  /* Seam shape: everything the storage ops need rides on this wrapper, so
   * tests inject a { bucket, send } twin instead of a live client. */
  return {
    bucket: env.SIMO_S3_BUCKET,
    send: (cmd) => client.send(cmd),
    client,
  };
}

/* putObjects: one PutObject per file; resolves to the refs (name +
 * object_key + object_url + size_bytes) that feed db.js putUploadRefs. */
export async function putObjects(client, id, files) {
  validId(id);
  const refs = [];
  for (const { name, text } of files) {
    const key = objectKey(id, name);
    await client.send(new PutObjectCommand({
      Bucket: client.bucket,
      Key: key,
      Body: text,
    }));
    refs.push({
      name,
      object_key: key,
      object_url: 's3://' + client.bucket + '/' + key,
      size_bytes: Buffer.byteLength(text),
    });
  }
  return refs;
}

/* deleteObjects: list everything under the id prefix, then batch-delete it.
 * Best-effort by contract (the server logs and moves on). Returns the
 * number of keys queued for deletion. */
export async function deleteObjects(client, id) {
  validId(id);
  const listed = await client.send(new ListObjectsV2Command({
    Bucket: client.bucket,
    Prefix: 'uploads/' + id + '/',
  }));
  const keys = (listed.Contents || []).map((o) => o.Key)
    .filter((k) => typeof k === 'string');
  if (!keys.length) return 0;
  await client.send(new DeleteObjectsCommand({
    Bucket: client.bucket,
    Delete: { Objects: keys.map((k) => ({ Key: k })) },
  }));
  return keys.length;
}

/* getObjectBytes: drain a GetObject Body — node stream, async iterable, or
 * already-buffered bytes — into a Buffer. */
export async function getObjectBytes(client, key) {
  const r = await client.send(new GetObjectCommand({
    Bucket: client.bucket,
    Key: key,
  }));
  const body = r.Body;
  if (!body) return Buffer.alloc(0);
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}