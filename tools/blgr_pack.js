#!/usr/bin/env node
/* Shared BLGR binary packing logic.
 *
 * Direct port of tools/blgr_pack.py (generalized from sim/video_pack.py).
 * Matches the BLGR format expected by TrafficSimEngine in src/lib/engine.js.
 * FCD/summary XML is parsed line-by-line (readline) assuming SUMO's
 * pretty-printed one-element-per-line output — zero deps, memory-safe.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const TYPES = ['passenger', 'motorcycle', 'bus', 'truck', 'auto'];
export const TIDX = Object.fromEntries(TYPES.map((t, i) => [t, i]));

/* SUMO vClass -> render-class index (app.js VEH_TYPES order).
 * vType id matches TIDX first; vClass is the fallback for contributor ids
 * (e.g. bangloreCar, schoolbus, water-tanker). */
export const VCLASS_TO_IDX = {
  passenger: 0, private: 0, emergency: 0, authority: 0,
  vip: 0, armored: 0,
  motorcycle: 1, moped: 1, scooter: 1, e_scooter: 1,
  bus: 2, coach: 2,
  truck: 3, trailer: 3, delivery: 3,
  taxi: 4,
};

/* Sum contributor flow rates -> veh/hr.
 *
 * Counts <flow perHour> and the older <flow vehsPerHour> spelling.
 * Standalone <vehicle> elements are one-off departures (not a rate) and
 * period=/number= flow styles are not supported — both contribute 0. */
export function readDemand(rouPath) {
  const s = fs.readFileSync(rouPath, 'utf8');
  let total = 0.0;
  for (const m of s.matchAll(/<flow\b[^>]*>/g)) {
    const attrs = m[0];
    let rate = /\sperHour\s*=\s*"([^"]+)"/.exec(attrs);
    if (!rate) rate = /\svehsPerHour\s*=\s*"([^"]+)"/.exec(attrs);
    if (rate) {
      const v = parseFloat(rate[1]);
      if (Number.isFinite(v)) total += v;
    }
  }
  return total;
}

/* Parse a .rou.xml -> {vType id: render-class index}.
 *
 * Id match against TIDX wins (so id="auto" vClass="taxi" -> 4, the
 * auto-rickshaw class); otherwise vClass lookup; otherwise 0 (passenger). */
export function buildTypeMap(rouPath) {
  const tmap = {};
  const s = fs.readFileSync(rouPath, 'utf8');
  for (const m of s.matchAll(/<vType\b[^>]*>/g)) {
    const attrs = m[0];
    const id = /\sid\s*=\s*"([^"]+)"/.exec(attrs);
    const vid = id ? id[1] : null;
    if (!vid) continue;
    if (vid in TIDX) {
      tmap[vid] = TIDX[vid];
    } else {
      const vc = /\svClass\s*=\s*"([^"]+)"/.exec(attrs);
      const idx = vc ? VCLASS_TO_IDX[vc[1]] : undefined;
      tmap[vid] = idx === undefined ? 0 : idx;
    }
  }
  return tmap;
}

/* Build BLGR header: magic, version, nScenarios, nFrames, bounds (dm).
 * Layout <4sBBHhhhh> = 16 bytes. */
export function buildHeader(nScenarios, nFrames, bounds) {
  const b = Buffer.alloc(16);
  b.write('BLGR', 0, 'ascii');
  b.writeUInt8(1, 4);                       // version
  b.writeUInt8(nScenarios, 5);
  b.writeUInt16LE(nFrames, 6);
  b.writeInt16LE(bounds[0], 8);
  b.writeInt16LE(bounds[1], 10);
  b.writeInt16LE(bounds[2], 12);
  b.writeInt16LE(bounds[3], 14);
  return b;
}

/* The blob stores ids as u16 and x/y as i16 decimetres (±3276.7 m).
 * Reject unrepresentable records with an actionable message instead of
 * node's raw Buffer ERR_OUT_OF_RANGE stack. */
function checkRecord(v) {
  if (!Number.isInteger(v[0]) || v[0] < 0 || v[0] > 65535) {
    throw new Error(`BLGR pack: vehicle id ${v[0]} out of u16 range`);
  }
  for (const [i, ax] of [[1, 'x'], [2, 'y']]) {
    if (!Number.isInteger(v[i]) || v[i] < -32768 || v[i] > 32767) {
      throw new Error(`BLGR pack: ${ax}=${v[i]} dm exceeds i16 dm `
        + '(±3276.7 m) — the net lacks coordinate normalization '
        + '(netOffset); re-export it with offset normalization enabled');
    }
  }
}

/* Pack per-frame vehicle records into BLGR frame blobs.
 *
 * frames: list of frames; each frame is list of
 * [id, x_dm, y_dm, angle_div2, speed_x8, type_idx]
 *
 * Returns: bytes blob (concatenated frames, each: u16 n + n * 9 bytes) */
export function packFcd(frames) {
  const parts = [];
  for (const frame of frames) {
    const head = Buffer.alloc(2);
    head.writeUInt16LE(frame.length, 0);
    parts.push(head);
    for (const v of frame) {
      checkRecord(v);
      const rec = Buffer.alloc(9);
      rec.writeUInt16LE(v[0], 0);
      rec.writeInt16LE(v[1], 2);
      rec.writeInt16LE(v[2], 4);
      rec.writeUInt8(v[3], 6);
      rec.writeUInt8(v[4], 7);
      rec.writeUInt8(v[5], 8);
      parts.push(rec);
    }
  }
  return Buffer.concat(parts);
}

/* Pack per-frame stats into BLGR stats section.
 *
 * stats_rows: list of [through, moving, stopped, queued, gridlock] per frame
 * Returns: bytes (nFrames * 5 * u16) */
export function packStats(statsRows) {
  const parts = [];
  for (const row of statsRows) {
    const b = Buffer.alloc(10);
    for (let i = 0; i < 5; i++) b.writeUInt16LE(row[i], i * 2);
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/* Parse SUMO FCD XML for a scenario tag (line-based).
 *
 * typeMap: {vType id: render-class index} from buildTypeMap; unknown
 * types fall back to 0 (passenger). Returns [per, nVehicles]. */
export async function readFcd(tag, fcdDir, nFrames, typeMap = null) {
  const tmap = typeMap || {};
  const per = Array.from({ length: nFrames }, () => []);
  const ids = new Map();
  const fcdPath = path.join(fcdDir, `${tag}-fcd.xml`);
  const rl = readline.createInterface({
    input: fs.createReadStream(fcdPath, 'utf8'),
    crlfDelay: Infinity,
  });
  let t = -1;
  for await (const line of rl) {
    const tm = /<timestep\b[^>]*\btime\s*=\s*"([^"]+)"/.exec(line);
    if (tm) { t = Math.trunc(parseFloat(tm[1])); continue; }
    const vm = /<vehicle\b[^>]*>/.exec(line);
    if (!vm) continue;
    if (t < 0 || t >= nFrames) continue;
    const a = vm[0];
    const g = (name) => {
      const mm = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"').exec(a);
      return mm ? mm[1] : null;
    };
    const vid = g('id');
    let idx;
    if (ids.has(vid)) idx = ids.get(vid);
    else { idx = ids.size; ids.set(vid, idx); }
    per[t].push([
      idx,
      Math.round(parseFloat(g('x')) * 10),
      Math.round(parseFloat(g('y')) * 10),
      Math.trunc(parseFloat(g('angle')) / 2) % 180,
      Math.min(255, Math.trunc(parseFloat(g('speed')) * 8)),
      tmap[g('type')] ?? 0,
    ]);
  }
  return [per, ids.size];
}

/* Parse SUMO summary XML for a scenario tag (line-based). */
export async function readSummary(tag, fcdDir, nFrames) {
  const sumPath = path.join(fcdDir, `${tag}-sum.xml`);
  const out = Array.from({ length: nFrames }, () => [0, 0, 0, 0, 0]);
  const rl = readline.createInterface({
    input: fs.createReadStream(sumPath, 'utf8'),
    crlfDelay: Infinity,
  });
  const clamp16 = (v) => Math.min(65535, v);
  for await (const line of rl) {
    const sm = /<step\b[^>]*>/.exec(line);
    if (!sm) continue;
    const a = sm[0];
    const g = (name) => {
      const mm = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"').exec(a);
      return mm ? mm[1] : null;
    };
    const t = Math.trunc(parseFloat(g('time')));
    if (t < 0 || t >= nFrames) continue;
    const run = Math.trunc(parseFloat(g('running')));
    const halt = Math.trunc(parseFloat(g('halting')));
    out[t] = [
      clamp16(Math.trunc(parseFloat(g('arrived')))),
      clamp16(Math.max(0, run - halt)),
      clamp16(halt),
      clamp16(Math.trunc(parseFloat(g('waiting')))),
      clamp16(Math.trunc(parseFloat(g('teleports')))),
    ];
  }
  return out;
}
