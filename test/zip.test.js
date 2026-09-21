/* src/lib/zip.js — a minimal deterministic ZIP writer for the area
 * export (plan: export both files, shipped as ONE zip): the server
 * bundles "<name>.net.xml" + "<name>.osm.xml" into a single
 * application/zip attachment; the client just saves the Blob — no
 * client-side unzip/parse. Classic PKZIP layout (deflate with a store
 * fallback), CRC-32 locked by the classic '123456789' vector, and every
 * round-trip below goes through the SYSTEM unzip — a wrong CRC or a
 * broken central directory fails the suite against the real tool, not a
 * reimplementation. DOM-free like the rest of src/lib (locked by
 * test/lib-purity.test.js).
 */
import { afterAll, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZip, crc32 } from '../src/lib/zip.js';

const UNZIP = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const TMPDIRS = [];
afterAll(() => {
  for (const td of TMPDIRS) {
    fs.rmSync(td, { recursive: true, force: true });
  }
});

function zipToDisk(entries) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-ziplib-'));
  TMPDIRS.push(td);
  const p = path.join(td, 'out.zip');
  fs.writeFileSync(p, buildZip(entries));
  return p;
}

it('crc32 matches the classic check vector', () => {
  expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
});

it.skipIf(!UNZIP)('two text entries round-trip through the system unzip', () => {
  const p = zipToDisk([
    { name: 'test-area.net.xml',
      body: '<net>\n<!-- simo:zoom=14 -->\n</net>' },
    { name: 'test-area.osm.xml',
      body: '<osm>bengaluru — ಬೆಂಗಳೂರು ಎಕ್ಸ್‌ಟ್ರಾಕ್ಟ್</osm>' },
  ]);
  const names = execFileSync('unzip', ['-Z1', p]).toString('utf8')
    .split('\n').filter(Boolean).sort();
  expect(names).toEqual(['test-area.net.xml', 'test-area.osm.xml']);
  expect(execFileSync('unzip', ['-p', p, 'test-area.net.xml'])
    .toString('utf8')).toBe('<net>\n<!-- simo:zoom=14 -->\n</net>');
  expect(execFileSync('unzip', ['-p', p, 'test-area.osm.xml'])
    .toString('utf8')).toBe('<osm>bengaluru — ಬೆಂಗಳೂರು ಎಕ್ಸ್‌ಟ್ರಾಕ್ಟ್</osm>');
});

it.skipIf(!UNZIP)('binary entries survive a real extraction (CRC verified)', () => {
  const bytes = new Uint8Array(
    [0, 159, 146, 150, 10, 13, 0, 255, 1, 2, 3, 250]);
  const p = zipToDisk([{ name: 'bin.dat', body: bytes }]);
  const out = path.join(path.dirname(p), 'x');
  execFileSync('unzip', ['-o', p, '-d', out]);
  expect([...fs.readFileSync(path.join(out, 'bin.dat'))])
    .toEqual([...bytes]);
});

it('buildZip is deterministic (fixed DOS timestamp, stable bytes)', () => {
  const entries = [{ name: 'a.xml', body: '<a/>' }];
  const a = buildZip(entries);
  const b = buildZip(entries);
  expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
});

it.skipIf(!UNZIP)('compressible data actually shrinks (deflate, not store)', () => {
  const big = 'a'.repeat(16 * 1024);
  const p = zipToDisk([{ name: 'a.txt', body: big }]);
  expect(fs.statSync(p).size,
    'the deflate path must engage for repetitive XML')
    .toBeLessThan(big.length);
});

it.skipIf(!UNZIP)('pseudo-random bytes still round-trip (store fallback OK)', () => {
  let s = 123456789;
  const rnd = new Uint8Array(1024);
  for (let i = 0; i < rnd.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    rnd[i] = s & 0xff;
  }
  const p = zipToDisk([{ name: 'r.bin', body: rnd }]);
  const out = path.join(path.dirname(p), 'x');
  execFileSync('unzip', ['-o', p, '-d', out]);
  expect([...fs.readFileSync(path.join(out, 'r.bin'))]).toEqual([...rnd]);
});
