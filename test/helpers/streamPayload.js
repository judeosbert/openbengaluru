/* Stream-payload helper — replaces phase1/harness.js loadBalagereStream.
 *
 * Stream file format contract (locked, see plan): a single line of
 *   window.__simoStreamCallback('<id>',<JSON>);
 * served from public/streams/<id>.js. JSONP is kept — fetch() is NOT a
 * drop-in because tests (and loadSimStream) assert this exact format.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLAYER_ROOT = path.dirname(TEST_DIR);

export function readStreamPayload(simId) {
  const p = path.join(PLAYER_ROOT, 'public', 'streams', simId + '.js');
  const src = fs.readFileSync(p, 'utf8');
  const m = src.match(/^window\.__simoStreamCallback\('[^']+',\s*(\{.*\})\);\s*$/s);
  if (!m) throw new Error('stream file is not a __simoStreamCallback payload: ' + p);
  return JSON.parse(m[1]);
}

/* Decode the id set of one frame straight from the base64 stream blob:
   per frame u16 n, then n x 9-byte records <u16 id, i16 x, i16 y, u8 a/2,
   u8 speed*8, u8 type>. */
export function frameIds(stream, scenKey, frameNo) {
  const buf = Buffer.from(stream.scenarios[scenKey].frames, 'base64');
  let o = 0;
  for (let f = 0; f < frameNo; f++) {
    const n = buf.readUInt16LE(o); o += 2 + 9 * n;
  }
  const n = buf.readUInt16LE(o); o += 2;
  const ids = new Set();
  for (let i = 0; i < n; i++) { ids.add(buf.readUInt16LE(o)); o += 9; }
  return ids;
}

/* Count vehicles in a packed frames blob at frame floor(t). */
export function countStreamVehicles(framesB64, t) {
  const raw = Buffer.from(framesB64, 'base64');
  let o = 0;
  let f = 0;
  while (o + 2 <= raw.length) {
    const n = raw.readUInt16LE(o);
    o += 2;
    if (f === Math.trunc(t)) return n;
    o += n * 9;
    f += 1;
  }
  return 0;
}
