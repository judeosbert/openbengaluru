/* Pure client-lib tests for the review-flow client:
 * - src/lib/catalogMerge.js — the two-catalog-source merge (base bundle +
 *   /api/catalog): replace-by-id, API wins, apiStream stamp.
 * - src/lib/ingestSlot.js — the shared upload-ingest helper used by
 *   SubmitFlow's FileReader path AND the resubmit prefill: classification
 *   per slot, demand count, net geometry, reject messages.
 * Both run in the vitest node environment (src/lib is DOM-free).
 */
import { describe, it, expect } from 'vitest';
import { mergeApiEntries } from '../src/lib/catalogMerge.js';
import { ingestSlot } from '../src/lib/ingestSlot.js';

/* ------------------------------------------------------ catalogMerge --- */

const BASE = [
  { id: 'gen-1', title: 'Generated One', scenarios: { today: { stats: 'x' } } },
  { id: 'gen-2', title: 'Generated Two', scenarios: { today: { stats: 'y' } } },
];

it('mergeApiEntries appends API entries stamped apiStream', () => {
  const api = [{ id: 'user-a', title: 'User A', demand: 150 }];
  const out = mergeApiEntries(BASE, api);
  expect(out.map((e) => e.id)).toEqual(['gen-1', 'gen-2', 'user-a']);
  const merged = out.find((e) => e.id === 'user-a');
  expect(merged.apiStream).toBe(true);
  expect(merged.title).toBe('User A');
});

it('mergeApiEntries replaces base entries by id (API wins wholesale)', () => {
  const api = [{ id: 'gen-1', title: 'Updated One', demand: 42 }];
  const out = mergeApiEntries(BASE, api);
  expect(out.length).toBe(2);
  const first = out.find((e) => e.id === 'gen-1');
  expect(first.apiStream).toBe(true);
  expect(first.title).toBe('Updated One');
  expect(first.demand).toBe(42);
  expect(first.scenarios).toBeUndefined();  // replaced wholesale, no base leak
  expect(out.find((e) => e.id === 'gen-2')).toEqual(BASE[1]);
});

it('mergeApiEntries never mutates the base array and tolerates empty inputs', () => {
  const out = mergeApiEntries(BASE, []);
  expect(out).toEqual(BASE);
  expect(out).not.toBe(BASE);
  expect(mergeApiEntries([], [{ id: 'a' }]).length).toBe(1);
  expect(mergeApiEntries(BASE, null)).toEqual(BASE);
  // entries without an id are skipped, not appended
  expect(mergeApiEntries(BASE, [{ title: 'no id' }]).length).toBe(2);
});

/* -------------------------------------------------------- ingestSlot --- */

const ROU = '<routes><vehicle id="v0" depart="0" route="r0"/>'
  + '<vehicle id="v1" depart="1" route="r0"/></routes>';
const NET = '<?xml version="1.0"?><net>'
  + '<lane id="e1_0" shape="0,0 100,0" width="3.2"/>'
  + '</net>';

it('ingestSlot demand slot: record + parsed demand count', () => {
  const r = ingestSlot('demand', 'my.rou.xml', ROU);
  expect(r.reject).toBeNull();
  expect(r.fileRecord).toEqual({ name: 'my.rou.xml', size: ROU.length,
    kind: 'routes', text: ROU });
  expect(r.demandCount).toBe(2);
  expect(r.geo).toBeUndefined();
});

it('ingestSlot net slots: record + parsed geometry', () => {
  const today = ingestSlot('today', 'my.net.xml', NET);
  expect(today.reject).toBeNull();
  expect(today.fileRecord.kind).toBe('network');
  expect(today.demandCount).toBeUndefined();
  expect(today.geo).toBeTruthy();
  expect(today.geo.lanes.length).toBe(1);

  const proposed = ingestSlot('proposed', 'p.net.xml', NET);
  expect(proposed.reject).toBeNull();
  expect(proposed.geo).toBeTruthy();
});

it('ingestSlot rejects wrong-slot files with the slot message', () => {
  const r = ingestSlot('demand', 'net.net.xml', NET);
  expect(r.reject).toMatch(/needs a \.rou\.xml file/);
  expect(r.fileRecord).toBeNull();
  const r2 = ingestSlot('today', 'routes.rou.xml', ROU);
  expect(r2.reject).toMatch(/needs a \.net\.xml file/);
  expect(r2.fileRecord).toBeNull();
  const r3 = ingestSlot('proposed', 'config.sumocfg', '<x/>');
  expect(r3.reject).toMatch(/needs a \.net\.xml file/);
});

it('ingestSlot flags unparseable nets (0 lanes) via geo=null', () => {
  const r = ingestSlot('today', 'ok.net.xml', '<not-a-net>x</not-a-net>');
  expect(r.reject).toBeNull();              // classification is fine
  expect(r.fileRecord).toBeTruthy();
  expect(r.geo).toBeNull();                 // caller warns "parsed 0 lanes"
});

it('ingestSlot demand count 0 is reported but the file is kept', () => {
  const r = ingestSlot('demand', 'empty.rou.xml', '<routes/>');
  expect(r.reject).toBeNull();
  expect(r.demandCount).toBe(0);
  expect(r.fileRecord.name).toBe('empty.rou.xml');
});