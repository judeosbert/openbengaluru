/* TrafficSimEngine — decodes BLGR stream blobs or synthesises deterministic
 * traffic. Ported verbatim from the app.js pure head. */
import { b64ToBytes, hashStr } from './util.js';
import { laneProfile, pointOnLane } from './geo.js';

/* --------------------------------------------------- TrafficSimEngine
 * streamOrNull: BALAGERE_STREAM-shaped object ({nFrames, scenarios:{key:
 * {frames:b64, stats:b64}}}) or null for catalog-only sims.
 * scenarioGeoOrNull: geometry/catalog entry carrying .scenarios (used for
 * fallback stats and for vehicle synthesis when stream is null).
 * simId: stable string seeding the deterministic fake-stream synthesis.
 *
 * Blob formats (see build_player.py):
 *   frames: per frame u16LE n + n x 9-byte records
 *           <u16 id, i16 x, i16 y, u8 angle/2, u8 speed*8, u8 type>
 *   stats:  nFrames x 5 u16LE  [through, moving, stopped, queued, gridlock]
 * ------------------------------------------------------------------------*/
export class TrafficSimEngine {
  constructor(streamOrNull, scenarioGeoOrNull, simId) {
    this.stream = streamOrNull || null;
    this.geo = scenarioGeoOrNull || null;
    this.simId = String(simId == null ? 'sim' : simId);
    this._frames = {};   // scenKey -> array of Map(id -> [x,y,angle,speed,type])
    this._stats = {};    // scenKey -> array of [5] int rows
    this._synth = {};    // scenKey -> [laneProfile,...]
  }

  _scenMeta(key) {
    if (this.stream && this.stream.scenarios && this.stream.scenarios[key]) {
      return this.stream.scenarios[key];
    }
    if (this.geo && this.geo.scenarios && this.geo.scenarios[key]) {
      return this.geo.scenarios[key];
    }
    if (this.geo && this.geo.lanes) return this.geo;   // single-scenario object
    return null;
  }

  frameCount(key) {
    if (this.stream && this.stream.nFrames) return this.stream.nFrames;
    if (this.geo && this.geo.nFrames) return this.geo.nFrames;
    const meta = this._scenMeta(key);
    if (meta && meta.stats) return Math.floor(b64ToBytes(meta.stats).length / 10);
    return 900;
  }

  _decodeFrames(key) {
    const meta = this._scenMeta(key);
    if (!meta || !meta.frames) return null;
    const bytes = b64ToBytes(meta.frames);
    const dv = new DataView(bytes.buffer);
    const NF = this.frameCount(key);
    const frames = new Array(NF);
    let o = 0;
    for (let f = 0; f < NF; f++) {
      if (o + 2 > bytes.length) { frames[f] = new Map(); continue; }
      const n = dv.getUint16(o, true); o += 2;
      const m = new Map();
      for (let i = 0; i < n && o + 9 <= bytes.length; i++) {
        m.set(dv.getUint16(o, true), [
          dv.getInt16(o + 2, true),       // x  (dm)
          dv.getInt16(o + 4, true),       // y  (dm)
          dv.getUint8(o + 6) * 2,         // heading deg
          dv.getUint8(o + 7) / 8,         // speed m/s
          dv.getUint8(o + 8),             // type idx
        ]);
        o += 9;
      }
      frames[f] = m;
    }
    return frames;
  }

  /* NEW array of fresh rows [id, xDm, yDm, angleDeg, speedMps, type] on every
   * call — caller mutation must never leak into later calls. */
  getVehiclesAtTime(t, scenKey) {
    t = Number(t);
    if (!isFinite(t)) t = 0;
    const NF = this.frameCount(scenKey);
    let tc = t;
    if (tc < 0) tc = 0;
    if (tc > NF - 1) tc = NF - 1;
    const f0 = Math.floor(tc);
    const f1 = Math.min(NF - 1, f0 + 1);
    const a = tc - f0;

    const meta = this._scenMeta(scenKey);
    if (meta && meta.frames) {
      let frames = this._frames[scenKey];
      if (!frames) { frames = this._decodeFrames(scenKey) || []; this._frames[scenKey] = frames; }
      const A = frames[f0] || new Map(), B = frames[f1] || new Map();
      const rows = [];
      for (const [id, v] of A) {
        let x = v[0], y = v[1], ang = v[2];
        const w = B.get(id);
        if (w) {
          x += (w[0] - x) * a;
          y += (w[1] - y) * a;
          const d = ((w[2] - ang + 540) % 360) - 180;   // wrap-safe lerp
          ang += d * a;
        }
        rows.push([id, x, y, ang, v[3], v[4]]);
      }
      return rows;
    }
    return this._synthVehicles(scenKey, tc);
  }

  /* ~40 deterministic vehicles circulating along the scenario lanes; pure
   * function of (simId, scenKey, t) — no Math.random at call time. */
  _synthVehicles(scenKey, t) {
    const meta = this._scenMeta(scenKey);
    const lanes = meta && meta.lanes ? meta.lanes : [];
    if (!lanes.length) return [];
    let profs = this._synth[scenKey];
    if (!profs) { profs = laneProfile(lanes); this._synth[scenKey] = profs; }
    const COUNT = 40;
    const rows = [];
    for (let i = 0; i < COUNT; i++) {
      const h = hashStr(this.simId + ':' + scenKey + ':' + i);
      const prof = profs[h % profs.length];
      const u0 = ((h >>> 8) % 1000) / 1000;
      const speedDm = 25 + ((h >>> 18) % 85);              // 2.5 .. 11 m/s
      const dist = u0 * prof.len + t * speedDm;
      const p = pointOnLane(prof, dist);
      const wobble = 0.85 + 0.15 * Math.sin(t * 0.35 + i * 1.7);
      rows.push([i + 1, p[0], p[1], p[2], Math.max(0, speedDm / 10 * wobble), (h >>> 4) % 5]);
    }
    return rows;
  }

  _synthStats(scenKey, nf) {
    const h = hashStr(this.simId + ':' + scenKey + ':stats');
    const rows = new Array(nf);
    const rate = 0.6 + (h % 40) / 50, cap = 150 + (h % 600);
    for (let f = 0; f < nf; f++) {
      const through = Math.min(cap, Math.floor(f * rate));
      const moving = Math.max(0, 18 + (h % 37) + Math.round(8 * Math.sin(f / 37 + (h % 7))));
      const stopped = Math.max(0, 5 + ((h >>> 3) % 23) + Math.round(5 * Math.sin(f / 29 + 2)));
      const queued = Math.max(0, Math.round(40 * Math.sin(f / 80 + (h % 5)) + ((h >>> 5) % 30)));
      rows[f] = [through, moving, stopped, queued, 0];
    }
    return rows;
  }

  /* [through, moving, stopped, queued, gridlock] — 5 non-negative ints at
   * index floor(t) clamped into range. Fresh copy each call. */
  getStatsAt(t, scenKey) {
    let rows = this._stats[scenKey];
    if (!rows) {
      const meta = this._scenMeta(scenKey);
      if (meta && meta.stats) {
        const bytes = b64ToBytes(meta.stats);
        const dv = new DataView(bytes.buffer);
        const n = Math.floor(bytes.length / 10);
        rows = new Array(n);
        let o = 0;
        for (let f = 0; f < n; f++) {
          rows[f] = [
            dv.getUint16(o, true), dv.getUint16(o + 2, true),
            dv.getUint16(o + 4, true), dv.getUint16(o + 6, true),
            dv.getUint16(o + 8, true),
          ];
          o += 10;
        }
      } else {
        rows = this._synthStats(scenKey, this.frameCount(scenKey));
      }
      this._stats[scenKey] = rows;
    }
    t = Number(t);
    if (!isFinite(t)) t = 0;
    let i = Math.floor(t);
    if (i < 0) i = 0;
    if (i > rows.length - 1) i = rows.length - 1;
    return rows[i].slice();
  }

  clearCache() {
    this._frames = {};
    this._stats = {};
    this._synth = {};
  }
}
