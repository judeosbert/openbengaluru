/* Minimal deterministic ZIP writer (classic PKZIP) for the area export:
 * POST /api/export-net bundles the finished .net.xml + the fetched
 * .osm.xml into ONE application/zip attachment, and the client just
 * saves the Blob — nothing here is needed browser-side. Deflate via
 * node's zlib with a store fallback for incompressible bodies; the DOS
 * timestamp is FIXED so identical entries always produce identical
 * bytes (the repo's byte-stability habit). Pure Uint8Array/strings,
 * DOM-free like the rest of src/lib (locked by test/lib-purity.test.js;
 * round-trips verified against the system unzip in test/zip.test.js). */

import { deflateRawSync } from 'node:zlib';

/* CRC-32 (the zip polynomial), table-driven. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* Fixed DOS time/date (2026-01-01 00:00) — determinism over provenance. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const ENC = new TextEncoder();

const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff,
  (v >>> 24) & 0xff];
const bytesOf = (body) => typeof body === 'string'
  ? ENC.encode(body) : body;

/* entries: [{ name, body }] — body is a string (UTF-8 encoded) or a raw
 * Uint8Array. Returns the complete .zip bytes (local headers + data +
 * central directory + EOCD, sizes known upfront so no data descriptors). */
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  for (const { name, body } of entries) {
    const nameBytes = ENC.encode(name);
    const raw = bytesOf(body);
    const crc = crc32(raw);
    let method = 8;
    let data = deflateRawSync(raw, { level: 9 });
    if (data.length >= raw.length) {
      method = 0;
      data = raw;
    }
    const entryOffset = offset;
    push(Uint8Array.from([
      ...u32(0x04034b50), ...u16(20), ...u16(UTF8_FLAG), ...u16(method),
      ...u16(DOS_TIME), ...u16(DOS_DATE), ...u32(crc),
      ...u32(data.length), ...u32(raw.length),
      ...u16(nameBytes.length), ...u16(0),
    ]));
    push(nameBytes);
    push(data);
    central.push({
      nameBytes, method, crc, csize: data.length, usize: raw.length,
      offset: entryOffset,
    });
  }
  const cdOffset = offset;
  for (const e of central) {
    push(Uint8Array.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(UTF8_FLAG),
      ...u16(e.method), ...u16(DOS_TIME), ...u16(DOS_DATE), ...u32(e.crc),
      ...u32(e.csize), ...u32(e.usize), ...u16(e.nameBytes.length),
      ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(0),
      ...u32(e.offset),
    ]));
    push(e.nameBytes);
  }
  push(Uint8Array.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(offset - cdOffset), ...u32(cdOffset), ...u16(0),
  ]));
  const out = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
