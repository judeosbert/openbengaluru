/* TrafficSimEngine — decodes BLGR stream blobs into vehicle frames + stats.
 * Ported from the app.js pure head. There is NO synthetic fallback: a
 * scenario without frames yields no vehicles and zero stats — the UI shows
 * honest loading/error states instead of fabricated traffic. */
import { b64ToBytes } from './util.js';

/* --------------------------------------------------- TrafficSimEngine
 * streamOrNull: BALAGERE_STREAM-shaped object ({nFrames, scenarios:{key:
 * {frames:b64, stats:b64}}}) or null for catalog-only sims.
 * scenarioGeoOrNull: geometry/catalog entry carrying .scenarios (used when
 * the stream is null — frames/stats still come only from real data).
 *
 * Blob formats (see build_player.py):
 *   frames: per frame u16LE n + n x 9-byte records
 *           <u16 id, i16 x, i16 y, u8 angle/2, u8 speed*8, u8 type>
 *   stats:  nFrames x 5 u16LE  [through, moving, stopped, queued, gridlock]
 * ------------------------------------------------------------------------*/
export class TrafficSimEngine {
  constructor(streamOrNull, scenarioGeoOrNull) {
    this.stream = streamOrNull || null;
    this.geo = scenarioGeoOrNull || null;
    this._frames = {};   // scenKey -> array of Map(id -> [x,y,angle,speed,type])
    this._stats = {};    // scenKey -> array of [5] int rows
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
   * call — caller mutation must never leak into later calls. A frames-less
   * scenario returns [] (draw nothing — never a synthesized replacement). */
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
    if (!(meta && meta.frames)) return [];
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

  /* [through, moving, stopped, queued, gridlock] — 5 non-negative ints at
   * index floor(t) clamped into range. Fresh copy each call. Stats-less
   * scenarios yield all-zero rows (defensive — SimPanel gates the numbers
   * block on loaded frames and never renders this state as data). */
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
        rows = new Array(this.frameCount(scenKey)).fill([0, 0, 0, 0, 0]);
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
  }
}
