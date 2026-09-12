/* ============================================================================
 * SIMO — Bengaluru traffic lab (discovery + runner mockup)
 * BalagereTrafficSpec plan, Phase 2. React 18 UMD + Babel standalone + Leaflet.
 *
 * PURE HEAD (everything above the pure-region marker): JSX-free, DOM-free.
 * It is executed raw inside a Node vm by phase1/harness.js with stub
 * React/L and NO window/document/localStorage — keep it that way.
 * ==========================================================================*/

/* ---------------------------------------------------------------- helpers */

function b64ToBytes(b64) {
  const bin = atob(b64);
  const n = bin.length;
  const u8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function hashStr(s) {
  let h = 5381;
  s = String(s);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/* Deterministic pseudo-geometry helpers for sims without a real stream. */
function laneProfile(lanes) {
  return (lanes || []).map((L) => {
    const pts = L.p || [];
    const cum = [0];
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      len += Math.hypot(dx, dy);
      cum.push(len);
    }
    return { pts, cum, len: Math.max(len, 1e-6) };
  });
}

function pointOnLane(prof, dist) {
  const pts = prof.pts, cum = prof.cum;
  let d = ((dist % prof.len) + prof.len) % prof.len;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = cum[i] - cum[i - 1] || 1;
  const a = (d - cum[i - 1]) / seg;
  const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * a;
  const y = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * a;
  const deg = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) * 180 / Math.PI;
  const ang = (90 - deg + 360) % 360;   // same heading convention as the stream
  return [x, y, ang];
}

/* --------------------------------------------------------- TrafficSimEngine
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
class TrafficSimEngine {
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

/* --------------------------------------------------- upload file classifier
 * Bundle contract: .rou.xml -> routes, .net.xml -> network, .sumocfg ->
 * config (all case-insensitive); anything else -> null (rejected). */
function classifyUploadFile(name, size) {
  const n = String(name == null ? '' : name);
  const lower = n.toLowerCase();
  let kind = null;
  if (/\.rou\.xml$/.test(lower)) kind = 'routes';
  else if (/\.net\.xml$/.test(lower)) kind = 'network';
  else if (/\.sumocfg$/.test(lower)) kind = 'config';
  else return null;
  return { name: n, size: Math.max(0, size | 0), kind };
}

/* px per metre at (lat, zoom), clamped so geometry never collapses when the
 * map is zoomed out (LATM min-scale, plan decision table). */
function placementScale(lat, zoom) {
  return Math.max(
    Math.pow(2, zoom) / (156543.03392 * Math.cos(lat * Math.PI / 180)),
    2.5
  );
}

function slugTitle(title) {
  const s = String(title == null ? '' : title).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'sim';
}

/* ------------------------------------------------------ area export helpers
 * Contributors download the real OSM road network for a bbox, then run the
 * generated convert.sh (which auto-finds netconvert) to get a SUMO .net.xml.
 * bbox = [minLat, minLng, maxLat, maxLng]; both helpers are pure head so the
 * vm harness can test them. */
function osmApiUrl(bbox) {
  const b = bbox.map((v) => +(+v).toFixed(6));
  return 'https://www.openstreetmap.org/api/0.6/map?bbox='
    + b[1] + ',' + b[0] + ',' + b[3] + ',' + b[2];   // minLng,minLat,maxLng,maxLat
}

/* Bash script the contributor runs: netconvert from EclipseSUMO / $SUMO_HOME /
 * PATH. Produces <name>.net.xml next to the downloaded .osm.xml. */
function convertScript(bbox, name) {
  const nm = (name || 'area').replace(/[^a-z0-9-]+/g, '-');
  const B = bbox.map((v) => +(+v).toFixed(6));
  return '#!/bin/bash\n'
    + '# Export area [' + B.join(', ') + '] to a SUMO net. Run next to the\n'
    + '# downloaded ' + nm + '.osm.xml. netconvert auto-detects.\n'
    + '# netconvert keeps <location origBoundary> — the app uses it to auto-position.\n'
    + 'set -e\n'
    + 'NC=""\n'
    + 'for c in "$SUMO_HOME/bin/netconvert" \\\n'
    + '  "/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo/bin/netconvert" \\\n'
    + '  "$(command -v netconvert)"; do\n'
    + '  [ -x "$c" ] && NC="$c" && break\n'
    + 'done\n'
    + '[ -z "$NC" ] && { echo "netconvert not found — set SUMO_HOME"; exit 1; }\n'
    + 'OSM="' + nm + '.osm.xml"\n'
    + '[ -f "$OSM" ] || { echo "$OSM missing — download it from the app first"; exit 1; }\n'
    + '"$NC" --osm-files "$OSM" --output-file ' + nm + '.net.xml \\\n'
    + '  --geometry.remove --junctions.join --roundabouts.guess \\\n'
    + '  --tls.guess --tls.join --junctions.corner-detail 5\n'
    + '# carry the export zoom into the net (line 2) so the app can auto-snap\n'
    + 'ZOOM=$(grep -o \'simo:zoom=[0-9]*\' "$OSM" | head -1 | cut -d= -f2)\n'
    + 'if [ -n "$ZOOM" ]; then\n'
    + '  awk -v z="$ZOOM" \'NR==1{print; print "<!-- simo:zoom=" z " -->"; next}1\' '
    + nm + '.net.xml > ' + nm + '.net.xml.tmp && mv ' + nm + '.net.xml.tmp ' + nm + '.net.xml\n'
    + 'fi\n'
    + 'echo "wrote ' + nm + '.net.xml — upload it in the Submit wizard"\n';
}

/* ~40 m square around [lat,lng] — default zone for fresh submissions. */
function defaultZonePoly(latlng) {
  const lat = latlng[0], lng = latlng[1];
  const dLat = 20 / 111320;                              // 20 m half-side
  const dLng = 20 / (111320 * Math.cos(lat * Math.PI / 180) || 1);
  return [
    [lat - dLat, lng - dLng], [lat - dLat, lng + dLng],
    [lat + dLat, lng + dLng], [lat + dLat, lng - dLng],
  ];
}

/* Geometry for a submitted bundle. If the user uploaded a .net.xml, its
 * parsed lanes/phases (real road shape) drive the sim; otherwise a small
 * directed cross placeholder. The fake-stream engine synthesises vehicles
 * and stats from whatever lanes it is given. */
function defaultSimMeta(draft) {
  const h = hashStr('meta:' + (draft && draft.title));
  const demand = 900 + (h % 4200);
  const peakServed = Math.round(demand * (0.25 + ((h >>> 7) % 50) / 100));
  const cross = [
    { p: [[-250, -16], [250, -16]], w: 3.2 },
    { p: [[250, 16], [-250, 16]], w: 3.2 },
    { p: [[-16, -250], [-16, 250]], w: 3.2 },
    { p: [[16, 250], [16, -250]], w: 3.2 },
  ];
  const g = draft && draft.geo;
  const hasReal = g && Array.isArray(g.lanes) && g.lanes.length > 0;
  return {
    demand,
    peakServed,
    nFrames: 900,
    zonePoly: null,               // approveDraft fills the ~40 m square
    scenarios: {
      today: {
        title: 'TODAY',
        sub: hasReal
          ? 'submitted bundle · ' + g.lanes.length + ' lanes from .net.xml'
          : 'submitted bundle · placeholder geometry',
        lanes: hasReal ? g.lanes : cross,
        arms: hasReal ? (g.arms || {}) : {},
        phases: hasReal ? (g.phases || []) : [],
        stops: hasReal ? (g.stops || {}) : {},
        links: hasReal ? (g.links || {}) : {},
        /* geo-lock rides into the catalog entry so playback placement can
         * use simToLatLng instead of anchor+rotation */
        ...(hasReal && g.latlngMap
          ? { latlngMap: g.latlngMap, geoLocked: true } : {}),
        ...(hasReal && g.utm ? { utm: g.utm, geoLocked: true } : {}),
      },
    },
  };
}

/* ---------------------------------------------------------- approveDraft
 * Pure moderation step ("assume true"): draft -> new catalog entry.
 * Never mutates state or draft. */
function approveDraft(state, draft) {
  const locked = !!(draft.geo && draft.geo.geoLocked);
  /* geo-locked nets anchor at the downloaded bounds centre and cannot be
   * rotated — the map bounds already fix position and orientation. */
  const anchor = draft.latlng || (locked ? draft.geo.anchor : null);
  /* Auto-snap data for geo-locked nets: the downloaded bbox becomes the
   * entry's bounds + zone rectangle (replacing the default 40 m square), so
   * open/publish can fitBounds the map straight onto the net. The export's
   * suggestedZoom, when present, caps the fit. */
  const o = (locked && draft.geo.latlngMap) ? draft.geo.latlngMap.orig : null;
  const snapBounds = o ? [[o[0], o[1]], [o[2], o[3]]] : null;
  const snapPoly = o
    ? [[o[0], o[1]], [o[0], o[3]], [o[2], o[3]], [o[2], o[1]]]
    : null;
  const newEntry = {
    id: slugTitle(draft.title) + '-' + Date.now().toString(36),
    title: draft.title,
    author: draft.username,
    anchor: anchor,
    rotation: locked ? 0 : (draft.rotation || 0),
    demand: draft.simMeta.demand,
    peakServed: draft.simMeta.peakServed,
    nFrames: draft.simMeta.nFrames,
    zonePoly: draft.simMeta.zonePoly || snapPoly || defaultZonePoly(anchor),
    addedAt: new Date().toISOString().slice(0, 10),
    desc: draft.desc || '',
    scenarios: draft.simMeta.scenarios,
  };
  if (snapBounds) {
    newEntry.bounds = snapBounds;
    if (draft.geo.suggestedZoom != null) {
      newEntry.suggestedZoom = draft.geo.suggestedZoom;
    }
  }
  const catalog = state.catalog.concat(newEntry);
  return {
    ...state,
    catalog,
    view: 'submissions',
    activeSimId: newEntry.id,
    draftSub: null,
    toast: 'published',
  };
}

/* Seam for a future Google Maps implementation (plan: design decisions). */
const MapProvider = React.createContext(null);
/* Publishes the live canvas overlay so the submit wizard can drive the
 * draft-geometry preview (parseNetXml lanes) during anchor/rotation. */
const MapOverlayProvider = React.createContext(null);

/* ------------------------------------------------------------ store hook */
function useTrafficStore() {
  const { useState, useCallback } = React;

  const [view, setView] = useState('discover');
  const [catalog, setCatalog] = useState(() =>
    (typeof CATALOG !== 'undefined' ? CATALOG : []));
  const [activeSimId, setActiveSimId] = useState(null);
  const [activeScenario, setActiveScenario] = useState('today');
  const [running, setRunning] = useState(false);
  const [simT, setSimT] = useState(0);
  const [speed, setSpeed] = useState(30);
  const [draftSub, setDraftSub] = useState(null);
  const [toast, setToast] = useState(null);
  const [username, setUsernameState] = useState(() => {
    if (typeof localStorage !== 'undefined') {
      try { return localStorage.getItem('simo.username') || ''; } catch (e) { /* ignore */ }
    }
    return '';
  });

  const setUsername = useCallback((name) => {
    setUsernameState(name);
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem('simo.username', name); } catch (e) { /* ignore */ }
    }
  }, []);

  const viewSim = useCallback((id) => {
    setActiveSimId(id);
    setRunning(false);
  }, []);

  const runOnMap = useCallback((id) => {
    if (id) setActiveSimId(id);
    setSimT(0);
    setRunning(true);
  }, []);

  const stopAll = useCallback(() => { setRunning(false); }, []);

  const setScenario = useCallback((key) => {
    setActiveScenario(key);
    setSimT(0);
    setRunning(false);      // plan failure-mode 6: toggle kills playback
  }, []);

  const closeSim = useCallback(() => {
    setRunning(false);
    setActiveSimId(null);
  }, []);

  const startDraft = useCallback(() => {
    setDraftSub({
      username, files: [], latlng: null, rotation: 0,
      title: '', desc: '', simMeta: null, geo: null,
    });
  }, [username]);

  const cancelDraft = useCallback(() => { setDraftSub(null); }, []);

  /* Parsed .net.xml geometry for the live draft preview overlay */
  const setDraftGeo = useCallback((geo) => {
    setDraftSub((d) => (d ? { ...d, geo } : d));
  }, []);

  const updateDraft = useCallback((patch) => {
    if (patch && typeof patch.username === 'string') setUsername(patch.username);
    setDraftSub((d) => (d ? { ...d, ...patch } : d));
  }, [setUsername]);

  const placeDraft = useCallback((latlng) => {
    setDraftSub((d) => (d ? { ...d, latlng } : d));
  }, []);

  const submitDraft = useCallback(() => {
    if (!draftSub) return;
    const draft = draftSub.simMeta
      ? draftSub
      : { ...draftSub, simMeta: defaultSimMeta(draftSub) };
    const next = approveDraft({ catalog }, draft);
    setCatalog(next.catalog);
    setView(next.view);
    setActiveSimId(next.activeSimId);
    setRunning(false);
    setSimT(0);
    setDraftSub(null);
    setToast(next.toast);
  }, [catalog, draftSub]);

  const dismissToast = useCallback(() => { setToast(null); }, []);

  /* RAF tick: advance simT by speed x dt (frames are 1 Hz samples), stop at
   * the last frame. */
  const tick = useCallback((dt) => {
    setSimT((t) => {
      const entry = catalog.find((e) => e.id === activeSimId);
      const nf = entry ? entry.nFrames : 900;
      const nt = t + dt * speed;
      if (nt >= nf - 1) { setRunning(false); return nf - 1; }
      return nt;
    });
  }, [catalog, activeSimId, speed]);

  return {
    view, catalog, activeSimId, activeScenario, running, simT, speed,
    draftSub, toast, username,
    setView, setUsername, viewSim, runOnMap, stopAll, setScenario, closeSim,
    startDraft, cancelDraft, updateDraft, placeDraft, submitDraft, setDraftGeo,
    dismissToast, setSimT, setSpeed, tick,
  };
}

/* ---------------------------------------------------------- parseNetXml
 * SUMO .net.xml -> player geometry {lanes, arms, phases, stops, links}.
 * Lane shapes are metres in the net file; output is decimetres (dm) like
 * build_player's geom(). Uses DOMParser in the browser, a regex fallback
 * under the Node test harness (no DOM there). Returns null on no lanes. */
function parseNetXml(xmlText) {
  if (!xmlText || typeof xmlText !== 'string') return null;
  const lanes = [];
  const phases = [];
  const stops = {};
  const links = {};
  const laneShape = {};                       // laneId -> last shape pt (dm)
  let convB = null, origB = null;             // <location> bboxes (4 floats)
  let netOff = null, projStr = null;          // <location> projection (utm)

  const bbox4 = (s) => {
    if (!s) return null;
    const v = String(s).split(',').map(parseFloat);
    return (v.length === 4 && v.every((x) => isFinite(x))) ? v : null;
  };
  /* netOffset: 2 comma floats, SIGNED (sim_coords = utm + netOffset). */
  const vec2 = (s) => {
    if (!s) return null;
    const v = String(s).split(',').map(parseFloat);
    return (v.length === 2 && v.every((x) => isFinite(x))) ? v : null;
  };

  /* Zoom channel: the export stamps a <!-- simo:zoom=NN --> comment and
   * convert.sh copies it into the net. Comments are plain text, so one regex
   * over the raw XML covers the DOMParser and regex-fallback paths alike. */
  const zoomM = /simo:zoom=(\d+)/.exec(xmlText);
  const suggestedZoom = zoomM ? parseInt(zoomM[1], 10) : null;

  function pushLane(id, shapeStr, wStr) {
    if (!shapeStr) return;
    const pts = shapeStr.trim().split(/\s+/).map((q) => {
      const v = q.split(',');
      return [Math.round(parseFloat(v[0]) * 10),
              Math.round(parseFloat(v[1]) * 10)];
    }).filter((p) => isFinite(p[0]) && isFinite(p[1]));
    if (pts.length < 2) return;
    const w = parseFloat(wStr);
    lanes.push({ p: pts, w: isFinite(w) && w > 0 ? w : 3.2 });
    if (id) laneShape[id] = pts[pts.length - 1];
  }

  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) return null;
    doc.querySelectorAll('lane[id]').forEach((el) => {
      const id = el.getAttribute('id') || '';
      if (id.indexOf(':') === 0) return;      // internal junction lanes
      const sh = el.getAttribute('shape');
      if (sh) pushLane(id, sh, el.getAttribute('width'));
    });
    doc.querySelectorAll('tlLogic phase').forEach((el) => {
      const dur = parseFloat(el.getAttribute('duration'));
      const st = el.getAttribute('state');
      if (isFinite(dur) && st) phases.push([dur, st]);
    });
    doc.querySelectorAll('connection[tl][linkIndex]').forEach((el) => {
      const frm = el.getAttribute('from');
      const idx = parseInt(el.getAttribute('linkIndex'), 10);
      if (!frm || !isFinite(idx)) return;
      (links[frm] = links[frm] || []).push(idx);
      const end = laneShape[frm + '_0'];
      if (end) stops[frm] = end;
    });
    const locEl = doc.querySelector('location');
    if (locEl) {
      convB = bbox4(locEl.getAttribute('convBoundary'));
      origB = bbox4(locEl.getAttribute('origBoundary'));
      netOff = vec2(locEl.getAttribute('netOffset'));
      projStr = locEl.getAttribute('projParameter');
    }
  } else {
    /* regex fallback: same extraction as build_player.geom() */
    const laneRe = /<lane id="([^:][^"]*)"([^>]*)>?/g;
    let m;
    while ((m = laneRe.exec(xmlText))) {
      const attrs = m[2];
      const sh = /shape="([^"]+)"/.exec(attrs);
      if (!sh) continue;
      const w = /width="([\d.]+)"/.exec(attrs);
      pushLane(m[1], sh[1], w && w[1]);
    }
    const phRe = /<phase duration="([\d.]+)" state="(\w+)"/g;
    while ((m = phRe.exec(xmlText))) phases.push([parseFloat(m[1]), m[2]]);
    const cnRe = /<connection from="([^"]+)"[^>]*tl="[^"]*"[^>]*linkIndex="(\d+)"/g;
    while ((m = cnRe.exec(xmlText))) {
      const frm = m[1], idx = parseInt(m[2], 10);
      (links[frm] = links[frm] || []).push(idx);
      if (laneShape[frm + '_0']) stops[frm] = laneShape[frm + '_0'];
    }
    const locTag = /<location\s[^>]*>/.exec(xmlText);
    if (locTag) {
      const cm = /convBoundary="([^"]+)"/.exec(locTag[0]);
      const om = /origBoundary="([^"]+)"/.exec(locTag[0]);
      const nm = /netOffset="([^"]+)"/.exec(locTag[0]);
      const pm = /projParameter="([^"]+)"/.exec(locTag[0]);
      convB = cm ? bbox4(cm[1]) : null;
      origB = om ? bbox4(om[1]) : null;
      netOff = nm ? vec2(nm[1]) : null;
      projStr = pm ? pm[1] : null;
    }
  }

  /* netconvert's own projection: a UTM projParameter (+proj=utm +zone=NN)
   * means sim coords are (utm + netOffset) metres, so the EXACT inverse is
   * utmToLatLng(sim - netOffset) — far truer than the bbox stretch. utm rides
   * alongside latlngMap (whose orig bbox still drives bounds/snap). */
  let utm = null;
  const zoneM = projStr && /\+zone=(\d+)/.exec(projStr);
  if (netOff && projStr && /\+proj=utm/.test(projStr) && zoneM
      && +zoneM[1] >= 1 && +zoneM[1] <= 60) {
    utm = { offX: netOff[0], offY: netOff[1],
            zone: parseInt(zoneM[1], 10),
            south: /\+south/.test(projStr) };
  }

  if (!lanes.length) return null;

  /* Geo-lock: a real netconvert net carries its WGS84 provenance in
   * <location convBoundary origBoundary> (conv metres, orig degrees in
   * minLng,minLat,maxLng,maxLat order). When both bboxes are sane — hand
   * nets write -1e10 sentinels — lanes STAY in their original metres frame:
   * simToLatLng() maps them straight onto the map, so the wizard needs no
   * anchor/rotation. orig is stored as [minLat,minLng,maxLat,maxLng]. */
  let latlngMap = null;
  if (convB && origB
      && origB.every((v) => Math.abs(v) <= 1000)
      && convB[2] > convB[0] && convB[3] > convB[1]
      && origB[2] > origB[0] && origB[3] > origB[1]) {
    latlngMap = { conv: convB,
                  orig: [origB[1], origB[0], origB[3], origB[2]] };
  }
  if (latlngMap) {
    const xs = [], ys = [];
    for (const l of lanes) {
      for (const p of [l.p[0], l.p[l.p.length - 1]]) { xs.push(p); ys.push(p); }
    }
    xs.sort((a, b) => a[0] - b[0]);
    ys.sort((a, b) => a[1] - b[1]);
    const arms = { West: xs[0], East: xs[xs.length - 1],
                   South: ys[0], North: ys[ys.length - 1] };
    const o = latlngMap.orig;
    return {
      lanes, arms, phases, stops, links, latlngMap,
      anchor: [(o[0] + o[2]) / 2, (o[1] + o[3]) / 2],
      geoLocked: true,
      ...(utm ? { utm } : {}),
      ...(suggestedZoom != null ? { suggestedZoom } : {}),
    };
  }

  /* Recenter to the bounds centroid: the wizard anchor maps to sim (0,0), and
   * without this a netconvert net (coords e.g. 0..11820 dm) pins its
   * bottom-left corner instead of its centre. Applies to lanes, arms, stops. */
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lanes) {
    for (const p of l.p) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (const l of lanes) {
    l.p = l.p.map((p) => [p[0] - cx, p[1] - cy]);
  }
  const shift = (p) => [p[0] - cx, p[1] - cy];
  const arms = {};
  for (const k of Object.keys(stops)) stops[k] = shift(stops[k]);
  /* arms from the outermost recentered lane endpoints (compass labels) */
  const xs = [], ys = [];
  for (const l of lanes) {
    for (const p of [l.p[0], l.p[l.p.length - 1]]) { xs.push(p); ys.push(p); }
  }
  xs.sort((a, b) => a[0] - b[0]);
  ys.sort((a, b) => a[1] - b[1]);
  arms.West = xs[0]; arms.East = xs[xs.length - 1];
  arms.South = ys[0]; arms.North = ys[ys.length - 1];
  return { lanes, arms, phases, stops, links,
           ...(utm ? { utm } : {}),
           ...(suggestedZoom != null ? { suggestedZoom } : {}) };
}

/* ---------------------------------------------------------- utmToLatLng
 * Standard USGS transverse-Mercator inverse (WGS84 ellipsoid): UTM easting/
 * northing (metres) + zone -> [latDeg, lngDeg]. This is the exact inverse of
 * the projection netconvert applied, so a UTM net's sim coords (which are
 * utm + netOffset) land back on their true WGS84 positions to <1 cm. */
function utmToLatLng(E, N, zone, south) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = E - 500000, y = N - (south ? 1e7 : 0);
  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 * e1 * e1 / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * e1 * e1 * e1 * e1 / 32) * Math.sin(4 * mu)
    + (151 * e1 * e1 * e1 / 96) * Math.sin(6 * mu)
    + (1097 * e1 * e1 * e1 * e1 / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1), cos1 = Math.cos(phi1), tan1 = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
  const T1 = tan1 * tan1;
  const C1 = ep2 * cos1 * cos1;
  const R1 = a * (1 - e2) / Math.pow(1 - e2 * sin1 * sin1, 1.5);
  const D = x / (N1 * k0);
  const lat = phi1 - (N1 * tan1 / R1) * (D * D / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2)
      * D * D * D * D / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1)
      * D * D * D * D * D * D / 720);
  const lng0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
  const lng = lng0 + (D
    - (1 + 2 * T1 + C1) * D * D * D / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1)
      * D * D * D * D * D / 120) / cos1;
  return [lat * 180 / Math.PI, lng * 180 / Math.PI];
}

/* ---------------------------------------------------------- simToLatLng
 * Geo-locked placement: local dm -> WGS84 [lat,lng]. Precedence:
 *  1. geo.utm — exact inverse of netconvert's own UTM transform
 *     (utm = sim - netOffset, signed);
 *  2. geo.latlngMap — convBoundary (metres) -> origBoundary (degrees) linear
 *     map. u/v clamp to [-0.5, 1.5] so out-of-bounds points stay near the
 *     edge instead of projecting unboundedly across the map.
 * Returns null for hand nets (neither) — those keep anchor+rotation. */
function simToLatLng(geo, xDm, yDm) {
  const x = xDm / 10, y = yDm / 10;
  if (geo && geo.utm) {
    const u = geo.utm;
    return utmToLatLng(x - u.offX, y - u.offY, u.zone, u.south);
  }
  const m = geo && geo.latlngMap;
  if (!m) return null;
  const clamp = (t) => Math.max(-0.5, Math.min(1.5, t));
  const u = clamp((x - m.conv[0]) / (m.conv[2] - m.conv[0]));
  const v = clamp((y - m.conv[1]) / (m.conv[3] - m.conv[1]));
  return [m.orig[0] + v * (m.orig[2] - m.orig[0]),
          m.orig[1] + u * (m.orig[3] - m.orig[1])];
}

/* Bridge: lexical bindings (class/const, and the consts from data.js) are
 * visible to later scripts in the same realm but NOT as properties of the
 * Node vm sandbox used by phase1/harness.js. Attach the test surface to the
 * realm global via globalThis (ECMAScript intrinsic — no window access). */
globalThis.TrafficSimEngine = TrafficSimEngine;
globalThis.useTrafficStore = useTrafficStore;
globalThis.MapProvider = MapProvider;
globalThis.MapOverlayProvider = MapOverlayProvider;
globalThis.parseNetXml = parseNetXml;
globalThis.simToLatLng = simToLatLng;
globalThis.utmToLatLng = utmToLatLng;
globalThis.osmApiUrl = osmApiUrl;
globalThis.convertScript = convertScript;
globalThis.approveDraft = approveDraft;
globalThis.classifyUploadFile = classifyUploadFile;
globalThis.placementScale = placementScale;
if (typeof CATALOG !== 'undefined') globalThis.CATALOG = CATALOG;
if (typeof OTHER_SIMS !== 'undefined') globalThis.OTHER_SIMS = OTHER_SIMS;
if (typeof BALAGERE_STREAM !== 'undefined') globalThis.BALAGERE_STREAM = BALAGERE_STREAM;
if (typeof BALAGERE_GEOMETRY !== 'undefined') globalThis.BALAGERE_GEOMETRY = BALAGERE_GEOMETRY;
if (typeof LANES_PALETTE !== 'undefined') globalThis.LANES_PALETTE = LANES_PALETTE;
if (typeof BALAGERE_CSS_STYLE !== 'undefined') globalThis.BALAGERE_CSS_STYLE = BALAGERE_CSS_STYLE;

//__PURE_END__
/* ============================================================================
 * Below the pure-region marker: JSX components (Babel standalone, React UMD
 * globals, Leaflet via global L). Never executed by the Node vm tests.
 * ==========================================================================*/

// <OVERLAY> ---------------------------------------------------------------
/* NOTE: components below use React.createElement (aliased h), not JSX.
 * index.html loads @babel/standalone (Babel 8) whose preset-react defaults
 * to the AUTOMATIC runtime — with data-presets="react" it emits
 * react/jsx-runtime imports that cannot execute as a classic file://
 * script. createElement output is identical; nothing here needs Babel. */
const h = React.createElement;
const GREEN_C = [53, 196, 107], AMBER_C = [240, 160, 43], RED_C = [245, 72, 79];
const VEH_TYPES = [[4.5, 1.8], [2.1, 0.8], [12, 2.5], [7.5, 2.4], [3.2, 1.5]];

function lerpC(a, b, t) {
  return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')';
}
function speedColor(v) {                    // red -> amber -> green by m/s
  if (v <= 0.4) return lerpC(RED_C, RED_C, 0);
  if (v < 3.5) return lerpC(RED_C, AMBER_C, (v - 0.4) / 3.1);
  if (v < 8) return lerpC(AMBER_C, GREEN_C, (v - 3.5) / 4.5);
  return lerpC(GREEN_C, GREEN_C, 0);
}
function phaseAt(ph, t) {
  if (!ph || !ph.length) return null;
  const cyc = ph.reduce((s, p) => s + p[0], 0);
  let u = t % cyc, a = 0;
  for (const [d, st] of ph) { a += d; if (u < a) return st; }
  return ph[ph.length - 1][1];
}
function fmtStat(v) {                       // mono, 4-digit clamp with '+'
  v = Math.max(0, Math.round(v));
  return v >= 9999 ? '9,999+' : v.toLocaleString();
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* The one sim backed by the real generated stream; all other catalog entries
 * synthesise vehicles from their own lanes. */
function isRealSim(entry) {
  return typeof BALAGERE_STREAM !== 'undefined'
    && typeof CATALOG !== 'undefined' && CATALOG.length > 0
    && entry && entry.id === CATALOG[0].id;
}

function engineFor(entry) {
  return isRealSim(entry)
    ? new TrafficSimEngine(BALAGERE_STREAM, BALAGERE_GEOMETRY, entry.id)
    : new TrafficSimEngine(null, entry, entry.id);
}
function scenarioGeoOf(entry, scenKey) {
  const src = isRealSim(entry) ? BALAGERE_GEOMETRY : entry;
  if (src && src.scenarios) {
    return src.scenarios[scenKey] || src.scenarios.today
      || src.scenarios[Object.keys(src.scenarios)[0]] || null;
  }
  return null;
}

/* Canvas overlay on the Leaflet overlay pane. Owns one <canvas> sized to the
 * map; redraws on moveend/zoomend/resize and on setTime (RAF-coalesced).
 * Placement: sim dm -> m (/10), rotate by entry.rotation, metres -> px via
 * placementScale (2.5 px/m floor keeps roads visible at low zoom), origin at
 * latLngToLayerPoint(anchor) - getPixelOrigin(). */
function makeSimOverlay(map) {
  let entry = null, scenKey = 'today', simT = 0;
  let draft = null;         // {geo, latlng, rotation} — live submit preview
  let eng = null, canvas = null, g = null, rafId = 0;

  /* debug handle: lets headless/manual QA read live overlay state */
  if (typeof window !== 'undefined') {
    window.__simoOverlay = {
      get draft() { return draft; },
      get entry() { return entry; },
      get hasCanvas() { return !!canvas; },
      map,
    };
  }

  function requestDraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
  }

  function draw() {
    if (!canvas || !g || !map) return;
    const size = map.getSize();
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (canvas.width !== Math.round(size.x * dpr)
        || canvas.height !== Math.round(size.y * dpr)) {
      canvas.width = Math.round(size.x * dpr);
      canvas.height = Math.round(size.y * dpr);
      canvas.style.width = size.x + 'px';
      canvas.style.height = size.y + 'px';
    }
    /* The canvas covers the viewport (appended to the map container, absolute
     * inset:0) and never moves with pan, so features are drawn straight at
     * latLngToContainerPoint(ll) — screen pixels, no origin compensation.
     * The earlier map.project()/getPixelOrigin()/pane-offset math all drew
     * the preview offscreen. */
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.x, size.y);
    if (!entry && !draft) return;

    const zoom = map.getZoom();
    /* Scale: natural geodesic fit at normal zoom; the LATM min-scale floor
     * applies ONLY when zoomed far out (<=11) so tiny geometry stays visible
     * — otherwise (zoom >= 12) the floor would inflate the overlay several
     * times past the map and the net never aligns. */
    const rawFit = Math.pow(2, zoom)
      / (156543.03392 * Math.cos(map.getCenter().lat * Math.PI / 180));
    const s = zoom <= 11 ? placementScale(map.getCenter().lat, zoom) : rawFit;
    /* anchor -> container px (screen coords of the visible viewport) */
    const anchorPx = (latlng) => {
      const cp = map.latLngToContainerPoint(L.latLng(latlng[0], latlng[1]));
      return [cp.x, cp.y];
    };

    /* ---- draft preview mode: parsed .net.xml lanes in accent red, live
     * over the map while the user pans/zooms/drags the rotation slider.
     * Same placement math as playback (dm->m, rotate, anchor origin, min-
     * scale floor) so what you see while anchoring is what playback draws. */
    if (draft && draft.geo && draft.latlng) {
      /* geo-locked net: the downloaded bounds fix position AND orientation,
       * so the anchor pin and rotation slider are ignored for the preview
       * itself — lanes project through simToLatLng. */
      const locked = !!(draft.geo.latlngMap || draft.geo.utm);
      let toPx, cx0, cy0;
      if (locked) {
        toPx = (xDm, yDm) => {
          const ll = simToLatLng(draft.geo, xDm, yDm);
          const cp = map.latLngToContainerPoint(L.latLng(ll[0], ll[1]));
          return [cp.x, cp.y];
        };
        [cx0, cy0] = toPx(0, 0);          // crosshair at the net's own (0,0)
      } else {
        const [ax, ay] = anchorPx(draft.latlng);
        const rot = (draft.rotation || 0) * Math.PI / 180;
        const cosR = Math.cos(rot), sinR = Math.sin(rot);
        toPx = (xDm, yDm) => {
          const xm = xDm / 10, ym = yDm / 10;
          const xr = xm * cosR - ym * sinR, yr = xm * sinR + ym * cosR;
          return [ax + xr * s, ay - yr * s];
        };
        [cx0, cy0] = [ax, ay];
      }
      const lanes = draft.geo.lanes || [];
      g.save();
      g.globalAlpha = 0.9;
      for (const pass of [0, 1]) {
        g.strokeStyle = pass ? '#FF5A60' : 'rgba(11,11,12,.85)';
        g.lineJoin = 'round';
        g.lineCap = 'round';
        for (const lane of lanes) {
          const w = Math.max(lane.w * s, 1.2);
          g.lineWidth = pass ? w : w + Math.max(2.5, s);
          g.beginPath();
          lane.p.forEach((p, k) => {
            const [X, Y] = toPx(p[0], p[1]);
            if (k) g.lineTo(X, Y); else g.moveTo(X, Y);
          });
          g.stroke();
        }
      }
      /* anchor crosshair (at the net's own (0,0) when geo-locked) */
      g.strokeStyle = '#E50914';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(cx0 - 9, cy0); g.lineTo(cx0 + 9, cy0);
      g.moveTo(cx0, cy0 - 9); g.lineTo(cx0, cy0 + 9);
      g.stroke();
      /* dashed reserve boundary from lane extent */
      if (lanes.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const l of lanes) {
          for (const p of l.p) {
            x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
            y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
          }
        }
        const pad = 60;                              // 6 m margin (dm)
        const c = [toPx(x0 - pad, y0 - pad), toPx(x1 + pad, y0 - pad),
                   toPx(x1 + pad, y1 + pad), toPx(x0 - pad, y1 + pad)];
        g.setLineDash([6, 5]);
        g.strokeStyle = 'rgba(229,9,20,.6)';
        g.lineWidth = 1.2;
        g.beginPath();
        c.forEach((p, k) => { if (k) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); });
        g.closePath();
        g.stroke();
        g.setLineDash([]);
      }
      g.restore();
      return;
    }

    const geo = scenarioGeoOf(entry, scenKey);
    if (!geo) return;

    /* geo-locked playback: the net's own projection (utm) or downloaded
     * bounds (latlngMap) fix placement, so the entry anchor/rotation are
     * ignored — lanes project via simToLatLng. */
    let toPx;
    if (geo.latlngMap || geo.utm) {
      toPx = (xDm, yDm) => {
        const ll = simToLatLng(geo, xDm, yDm);
        const cp = map.latLngToContainerPoint(L.latLng(ll[0], ll[1]));
        return [cp.x, cp.y];
      };
    } else {
      const [ax, ay] = anchorPx(entry.anchor);
      const rot = (entry.rotation || 0) * Math.PI / 180;
      const cosR = Math.cos(rot), sinR = Math.sin(rot);
      toPx = (xDm, yDm) => {
        const xm = xDm / 10, ym = yDm / 10;
        const xr = xm * cosR - ym * sinR, yr = xm * sinR + ym * cosR;
        return [ax + xr * s, ay - yr * s];
      };
    }

    // roads: dark casing pass, then core pass (build_player idiom)
    const lanes = geo.lanes || [];
    for (const pass of [0, 1]) {
      g.strokeStyle = pass ? '#3A3A40' : '#222227';
      g.lineJoin = 'round';
      g.lineCap = 'round';
      for (const lane of lanes) {
        const w = Math.max(lane.w * s, 1.2);
        g.lineWidth = pass ? w : w + Math.max(2.5, s);
        g.beginPath();
        lane.p.forEach((p, k) => {
          const [X, Y] = toPx(p[0], p[1]);
          if (k) g.lineTo(X, Y); else g.moveTo(X, Y);
        });
        g.stroke();
      }
    }

    // signals: phase state dots at stop-line positions
    const st = phaseAt(geo.phases || [], simT);
    if (st) {
      const rank = { G: 3, g: 2, y: 1, r: 0 };
      const col = { 3: '#35C46B', 2: '#288C50', 1: '#F0A02B', 0: '#46464C' };
      const stops = geo.stops || {}, links = geo.links || {};
      for (const frm of Object.keys(stops)) {
        const idx = links[frm] || [];
        let b = 0;
        for (const k of idx) b = Math.max(b, rank[st[k]] != null ? rank[st[k]] : 0);
        const [X, Y] = toPx(stops[frm][0], stops[frm][1]);
        g.fillStyle = col[b];
        g.strokeStyle = '#0B0B0C';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(X, Y, Math.max(3.5, 1.6 * s), 0, 6.2832);
        g.fill();
        g.stroke();
      }
    }

    // vehicles: speed-coloured rects rotated by heading
    if (eng) {
      const rows = eng.getVehiclesAtTime(simT, scenKey);
      for (const r of rows) {
        const [X, Y] = toPx(r[1], r[2]);
        if (X < -40 || Y < -40 || X > size.x + 40 || Y > size.y + 40) continue;
        const dims = VEH_TYPES[r[5]] || VEH_TYPES[0];
        const hl = Math.max(2, dims[0] * s / 2), hw = Math.max(1.3, dims[1] * s / 2);
        const th = -(90 - r[3]) * Math.PI / 180;          // build_player idiom
        g.save();
        g.translate(X, Y);
        g.rotate(th);
        g.fillStyle = speedColor(r[4]);
        g.fillRect(-hl, -hw, hl * 2, hw * 2);
        g.restore();
      }
    }

    // arm labels
    const arms = geo.arms || {};
    g.font = '700 11px "Helvetica Neue", Helvetica, Arial, sans-serif';
    g.fillStyle = '#9670C8';
    g.textAlign = 'center';
    for (const name of Object.keys(arms)) {
      const [X, Y] = toPx(arms[name][0], arms[name][1]);
      g.fillText(name, Math.min(Math.max(X, 44), size.x - 44),
        Math.min(Math.max(Y, 14), size.y - 8));
    }
  }

  const SimLayer = L.Layer.extend({
    onAdd: function () {
      canvas = L.DomUtil.create('canvas', 'sim-canvas');
      canvas.style.pointerEvents = 'none';
      canvas.style.position = 'absolute';
      canvas.style.top = '0';
      canvas.style.left = '0';
      /* append to the map CONTAINER (not a pane): the canvas covers the
       * viewport and never moves with pan, so latLngToContainerPoint()
       * (screen px) aligns with it exactly — no pane-offset compensation. */
      this._map.getContainer().appendChild(canvas);
      g = canvas.getContext('2d');
      this._map.on('moveend zoomend resize move', requestDraw);
      requestDraw();
    },
    onRemove: function () {
      this._map.off('moveend zoomend resize move', requestDraw);
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }   // RAF guard
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvas = null;
      g = null;
    },
  });
  const layer = new SimLayer();

  return {
    layer,
    setSim(e, key) {
      entry = e || null;
      scenKey = key || 'today';
      eng = entry ? engineFor(entry) : null;
      requestDraw();
    },
    /* live preview for the submit wizard: parsed net geometry + placement */
    setDraft(geo, latlng, rotation) {
      draft = geo && latlng ? { geo, latlng, rotation: rotation || 0 } : null;
      requestDraw();
    },
    clearDraft() { draft = null; requestDraw(); },
    setTime(t) { simT = t; requestDraw(); },
    /* playback sim only — must NOT touch the draft preview (SubmitFlow owns
     * that); called on panel close and on TrafficMap unmount. */
    clear() { entry = null; eng = null; requestDraw(); },
  };
}

// <ZONES_PINS> ------------------------------------------------------------
const PIN_ZOOM = 12.5;      // below: zone polygons only; at/above: pins too

/* One useEffect-managed L.layerGroup: a polygon per catalog zonePoly plus
 * divIcon pins at the anchors. divIcons land in the marker pane (z 620 in
 * BALAGERE_CSS_STYLE) — above the tile pane (200), below the popup pane
 * (660). */
function ZonesAndPins({ map, catalog, activeSimId, onViewSim }) {
  const [zoom, setZoom] = React.useState(() => map.getZoom());

  React.useEffect(() => {
    const onZ = () => setZoom(map.getZoom());
    map.on('zoomend', onZ);
    return () => { map.off('zoomend', onZ); };
  }, [map]);

  const bucket = zoom >= PIN_ZOOM;

  React.useEffect(() => {
    const grp = L.layerGroup().addTo(map);

    catalog.forEach((e, i) => {
      const col = LANES_PALETTE[i % LANES_PALETTE.length];
      const hasBoth = !!(e.scenarios && e.scenarios.today && e.scenarios.proposed);
      const badgeCol = hasBoth ? '#35C46B' : '#4E8DD9';   // PROPOSED green / TODAY blue

      const poly = L.polygon(e.zonePoly, {
        color: col, weight: 1.5, opacity: 0.85,
        fillColor: col, fillOpacity: 0.18,
      });
      poly.on('click', () => map.flyToBounds(poly.getBounds(), { padding: [48, 48] }));
      poly.addTo(grp);

      const c = e.zonePoly.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
      const centroid = [c[0] / e.zonePoly.length, c[1] / e.zonePoly.length];

      if (!bucket) {
        // zoomed out: polygon + small scenario badge at the centroid only
        const badge = L.marker(centroid, {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'zone-badge',
            html: '<span style="color:' + badgeCol + ';border-color:' + badgeCol + '">'
              + (hasBoth ? 'A/B' : 'TODAY') + '</span>',
            iconSize: null,
          }),
        });
        badge.addTo(grp);
        return;
      }

      // zoomed in: clickable pin at the real anchor
      const cls = 'sim-pin ' + (hasBoth ? 'proposed' : 'today')
        + (e.id === activeSimId ? ' active' : '');
      const pin = L.marker(e.anchor, {
        icon: L.divIcon({
          className: cls,
          html: '<div class="dot"><i class="pip"></i><span class="tag">'
            + escapeHtml(e.title) + '</span></div>',
          iconSize: null,
        }),
      });
      pin.bindTooltip(
        '<b>' + escapeHtml(e.title) + '</b> — ' + escapeHtml(e.author)
        + ' · <span class="num">' + e.demand.toLocaleString() + '/hr</span>',
        { direction: 'top', offset: [0, -10], className: 'sim-tt' }
      );
      pin.on('click', () => onViewSim(e.id));
      pin.addTo(grp);
    });

    return () => { grp.clearLayers(); grp.remove(); };
  }, [map, catalog, bucket, activeSimId, onViewSim]);

  return null;
}

// <SIM_PANEL> -------------------------------------------------------------
const HUD_LABELS = ['THROUGH', 'MOVING', 'STOPPED', 'QUEUED OUTSIDE', 'GRIDLOCKS'];

function SimScenarioToggle({ value, onChange, scenarios }) {
  const keys = ['today', 'proposed'].filter((k) => scenarios && scenarios[k]);
  return h('div', { className: 'scen-toggle' },
    keys.map((k) => h('button', {
      key: k,
      className: k === value ? '' : 'ghost',
      onClick: () => onChange(k),
    }, (scenarios[k].title || k).toUpperCase())));
}

function SimPanel({ entry, scenKey, simT, running, speed,
  onScenario, onRun, onStop, onScrub, onSpeed, onClose }) {
  const eng = React.useMemo(() => engineFor(entry), [entry && entry.id]);
  const stats = eng.getStatsAt(simT, scenKey);
  const geo = scenarioGeoOf(entry, scenKey);
  const nf = entry.nFrames || 900;
  const ss = Math.floor(Math.max(0, Math.min(nf - 1, simT)));
  const clock = String(Math.floor(ss / 60)).padStart(2, '0') + ':'
    + String(ss % 60).padStart(2, '0');
  const hasBoth = !!(entry.scenarios && entry.scenarios.today
    && entry.scenarios.proposed);
  const statColors = ['var(--green)', 'var(--ink)', 'var(--amber)',
    'var(--red)', stats[4] ? 'var(--red)' : 'var(--ink3)'];

  return h('div', { className: 'sheet' },
    h('button', { className: 'ghost closex', onClick: onClose }, '✕'),
    h('h2', null, entry.title),
    h('div', { className: 'by' },
      'by ', h('b', null, entry.author), ' · added ', entry.addedAt,
      geo && geo.sub ? h('span', null, ' · ', geo.sub) : null),
    entry.desc ? h('div', { className: 'by' }, entry.desc) : null,
    h('div', { className: 'statgrid' },
      h('div', null, h('b', null, 'DEMAND /HR'),
        h('span', { className: 'num' }, fmtStat(entry.demand))),
      h('div', null, h('b', null, 'PEAK SERVED'),
        h('span', { className: 'num' }, fmtStat(entry.peakServed)))),
    hasBoth ? h(SimScenarioToggle, {
      value: scenKey, onChange: onScenario, scenarios: entry.scenarios,
    }) : null,
    h('div', { className: 'statgrid' },
      HUD_LABELS.map((lab, k) => h('div', { key: lab },
        h('b', null, lab),
        h('span', { className: 'num', style: { color: statColors[k] } },
          fmtStat(stats[k])))),
      h('div', null, h('b', null, 'SIM TIME'),
        h('span', { className: 'num' }, clock))),
    h('div', { className: 'fld' },
      h('label', null, 'SCRUB'),
      h('input', {
        type: 'range', min: 0, max: nf - 1, step: 0.1,
        value: Math.min(simT, nf - 1),
        onInput: (ev) => onScrub(parseFloat(ev.target.value)),
      }),
      h('span', { className: 'val' }, clock)),
    h('div', { className: 'fld' },
      h('label', null, 'SPEED'),
      h('input', {
        type: 'range', min: 1, max: 90, step: 1, value: speed,
        onInput: (ev) => onSpeed(parseInt(ev.target.value, 10) || 1),
      }),
      h('span', { className: 'val' }, speed + '×')),
    h('div', { className: 'actions' },
      running
        ? h('button', { className: 'ghost', onClick: onStop }, 'Stop')
        : h('button', { onClick: () => onRun(entry.id) }, 'Run on Map')));
}

// <APP_SHELL> -------------------------------------------------------------
function TopBar({ view, onView, username, onUsername, onNewSim, onExport }) {
  return h('div', { className: 'topbar' },
    h('div', { className: 'mark' },
      h('i', null), 'SIMO ', h('small', null, 'BENGALURU TRAFFIC LAB')),
    h('div', { className: 'viewtoggle' },
      h('button', {
        className: view === 'discover' ? 'on' : '',
        onClick: () => onView('discover'),
      }, 'Discover'),
      h('button', {
        className: view === 'submissions' ? 'on' : '',
        onClick: () => onView('submissions'),
      }, 'My Submissions')),
    h('div', { className: 'userbox' },
      h('span', null, 'SIGNED IN AS'),
      h('input', {
        type: 'text', placeholder: 'username', value: username,
        onChange: (ev) => onUsername(ev.target.value),
      }),
      h('button', { className: 'ghost', onClick: onExport }, 'Export area'),
      h('button', { onClick: onNewSim }, 'Submit a sim')));
}

function TrafficMap({ store, onMap, onReady, onOverlay }) {
  const elRef = React.useRef(null);
  const overlayRef = React.useRef(null);
  const [map, setMap] = React.useState(null);

  /* Leaflet init: dark-filtered OSM tiles, Bengaluru centre + maxBounds.
   * Ready = first tile-layer `load` (all visible tiles fetched). data.js is
   * already evaluated before app.js runs, so tiles are the long pole. */
  React.useEffect(() => {
    const m = L.map(elRef.current, {
      center: [12.94, 77.72],
      zoom: 12,
      minZoom: 10,
      maxZoom: 19,
      maxBounds: [[12.80, 77.45], [13.10, 77.95]],
      maxBoundsViscosity: 0.7,
      zoomControl: true,
      attributionControl: true,
    });
    const tiles = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors',
      });
    let fired = false;
    tiles.on('load', () => {
      if (!fired) { fired = true; onReady(); }
    });
    tiles.addTo(m);
    /* safety: never trap the user behind the loader if tiles stall */
    const failSafe = setTimeout(() => {
      if (!fired) { fired = true; onReady(); }
    }, 12000);
    const overlay = makeSimOverlay(m);
    overlay.layer.addTo(m);
    overlayRef.current = overlay;
    setMap(m);
    onOverlay(overlay);
    onMap(m);
    return () => {
      clearTimeout(failSafe);
      onOverlay(null);
      onMap(null);
      setMap(null);
      overlayRef.current = null;
      overlay.clear();
      m.remove();
    };
  }, []);

  const entry = store.catalog.find((e) => e.id === store.activeSimId) || null;
  const scenKey = entry && entry.scenarios[store.activeScenario]
    ? store.activeScenario : 'today';

  /* attach / swap the overlay sim */
  React.useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (entry) overlay.setSim(entry, scenKey);
    else overlay.clear();
  }, [entry && entry.id, scenKey, map]);

  /* time scrub / playback position */
  React.useEffect(() => {
    if (overlayRef.current) overlayRef.current.setTime(store.simT);
  }, [store.simT, entry && entry.id, scenKey]);

  /* RAF playback: simT advances by speed x dt, engine stops at NF-1 */
  React.useEffect(() => {
    if (!store.running) return undefined;
    let raf = 0;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      store.tick(dt);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [store.running, store.tick]);

  return h(React.Fragment, null,
    h('div', { className: 'map-el', ref: elRef }),
    map ? h(ZonesAndPins, {
      map, catalog: store.catalog,
      activeSimId: store.activeSimId, onViewSim: store.viewSim,
    }) : null);
}

function App() {
  const store = useTrafficStore();
  const [map, setMap] = React.useState(null);
  const [mapReady, setMapReady] = React.useState(false);
  const [overlayApi, setOverlayApi] = React.useState(null);
  const [exportOpen, setExportOpen] = React.useState(false);

  const entry = store.catalog.find((e) => e.id === store.activeSimId) || null;
  const scenKey = entry && entry.scenarios[store.activeScenario]
    ? store.activeScenario : 'today';

  /* after a publish (catalog grew): snap to the new entry — fitBounds its
   * downloaded bbox when it has one (geo-locked), else fly to the anchor.
   * Panel opens via activeSimId (set by approveDraft through submitDraft). */
  const prevLen = React.useRef(store.catalog.length);
  React.useEffect(() => {
    if (store.catalog.length > prevLen.current) {
      const e = store.catalog[store.catalog.length - 1];
      if (map && e) {
        if (e.bounds) {
          map.fitBounds(e.bounds, {
            padding: [48, 48], maxZoom: e.suggestedZoom || 18, animate: true,
          });
        } else {
          map.flyTo(e.anchor, 16, { duration: 0.9 });
        }
      }
    }
    prevLen.current = store.catalog.length;
  }, [store.catalog.length, map]);

  /* auto-snap on open: clicking a geo-locked pin later fits the map to the
   * entry's downloaded bounds too. Only on a real id change, and never while
   * the draft wizard is open (it owns the map during anchoring). */
  const prevSimId = React.useRef(store.activeSimId);
  React.useEffect(() => {
    const id = store.activeSimId;
    const changed = id !== prevSimId.current;
    prevSimId.current = id;
    if (!changed || !map || store.draftSub) return;
    if (entry && entry.bounds) {
      map.fitBounds(entry.bounds, {
        padding: [48, 48], maxZoom: entry.suggestedZoom || 18, animate: true,
      });
    }
  }, [store.activeSimId, map, store.draftSub]);

  /* toast auto-dismiss */
  React.useEffect(() => {
    if (!store.toast) return undefined;
    const id = setTimeout(store.dismissToast, 2600);
    return () => clearTimeout(id);
  }, [store.toast, store.dismissToast]);

  const onScrub = (v) => { store.stopAll(); store.setSimT(v); };

  return h(React.Fragment, null,
    h(TopBar, {
      view: store.view, onView: store.setView,
      username: store.username, onUsername: store.setUsername,
      onNewSim: store.startDraft,
      onExport: () => setExportOpen(true),
    }),
    h(MapProvider.Provider, { value: map },
      h(MapOverlayProvider.Provider, { value: overlayApi },
        h('div', { className: 'map-wrap' },
          h(TrafficMap, {
            store, onMap: setMap, onReady: () => setMapReady(true),
            onOverlay: setOverlayApi,
          }),
          !mapReady ? h('div', { className: 'loader' },
            h('div', { className: 'mark' },
              h('i', null), h('span', null, 'SIMO — BENGALURU TRAFFIC LAB')),
            h('div', { className: 'spin' }),
            h('div', { className: 'msg' }, 'Loading map and simulations…'),
          ) : null,
          entry ? h(SimPanel, {
            entry, scenKey, simT: store.simT,
            running: store.running, speed: store.speed,
            onScenario: store.setScenario, onRun: store.runOnMap,
            onStop: store.stopAll, onScrub, onSpeed: store.setSpeed,
            onClose: store.closeSim,
          }) : null,
          store.draftSub ? h(SubmitFlow, { store }) : null,
          exportOpen && map ? h(ExportFlow, {
            map, onClose: () => setExportOpen(false),
          }) : null,
          store.toast ? h('div', {
            className: 'toast', onClick: store.dismissToast,
          }, store.toast === 'published'
            ? 'Published — your simulation is live on the map.'
            : String(store.toast)) : null))));
}

// <EXPORT_FLOW> -----------------------------------------------------------
/* Lets a contributor grab the real OSM road network for a chosen bbox and a
 * convert.sh that turns it into a SUMO .net.xml. Box drawn on the map. */
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function ExportFlow({ store, map, onClose }) {
  const [bbox, setBbox] = React.useState(() => {
    const b = map.getBounds();
    return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  });
  const [dragging, setDragging] = React.useState(false);
  const [status, setStatus] = React.useState('');
  const name = React.useRef('area');
  const boxRef = React.useRef(null);

  /* fixed-size box glued to a center crosshair while the modal is
   * minimized: pan the map to move the box, drag the box itself to
   * fine-position. Zoom stays locked so the box's geographic extent is
   * constant for the whole draw session. */
  React.useEffect(() => {
    if (!dragging) return undefined;

    /* zoom lock */
    map.scrollWheelZoom.disable();
    map.doubleClickZoom.disable();
    if (map.touchZoom) map.touchZoom.disable();
    if (map.boxZoom) map.boxZoom.disable();

    /* half-extents fixed once from the current view: the box spans the
     * middle 45% of the container on both axes (center ± 22.5%) */
    const sz = map.getSize();
    const nw = map.containerPointToLatLng(L.point(sz.x * 0.275, sz.y * 0.275));
    const se = map.containerPointToLatLng(L.point(sz.x * 0.725, sz.y * 0.725));
    const dLat = (nw.lat - se.lat) / 2;
    const dLng = (se.lng - nw.lng) / 2;
    const boundsAround = (c) => [
      [c.lat - dLat, c.lng - dLng],
      [c.lat + dLat, c.lng + dLng],
    ];
    const publish = (c) => setBbox(
      [c.lat - dLat, c.lng - dLng, c.lat + dLat, c.lng + dLng]);

    const rect = L.rectangle(boundsAround(map.getCenter()), {
      color: '#E50914', weight: 1.5, dashArray: '6 5', fillOpacity: 0.08,
    });
    rect.addTo(map);
    publish(map.getCenter());

    /* crosshair pinned to the container's exact center */
    const cross = document.createElement('div');
    cross.className = 'export-crosshair';
    cross.style.pointerEvents = 'none';
    const crossH = document.createElement('i');
    crossH.className = 'ch';
    const crossV = document.createElement('i');
    crossV.className = 'cv';
    cross.appendChild(crossH);
    cross.appendChild(crossV);
    const el = map.getContainer();
    el.appendChild(cross);

    /* pan-to-position: the box follows the crosshair on every map move */
    const onMove = () => {
      const c = map.getCenter();
      rect.setBounds(boundsAround(c));
      publish(c);
    };
    map.on('move', onMove);

    /* drag the box to fine-position: grab it anywhere inside its screen
     * bounds; while held, the map itself does not pan */
    let boxDrag = false;
    const insideBox = (ev) => {
      const p = map.mouseEventToContainerPoint(ev);
      const b = rect.getBounds();
      const pNw = map.latLngToContainerPoint(b.getNorthWest());
      const pSe = map.latLngToContainerPoint(b.getSouthEast());
      return p.x >= pNw.x && p.x <= pSe.x && p.y >= pNw.y && p.y <= pSe.y;
    };
    const dn = (ev) => {
      if (!insideBox(ev)) return;
      boxDrag = true;
      ev.preventDefault();
      map.dragging.disable();
    };
    const mv = (ev) => {
      if (boxDrag) {
        const ll = map.mouseEventToLatLng(ev);
        rect.setBounds(boundsAround(ll));
        publish(ll);
      } else {
        el.style.cursor = insideBox(ev) ? 'move' : '';
      }
    };
    /* mouseup lives on window so a release outside the map container can
     * never leave map.dragging disabled */
    const up = () => {
      if (!boxDrag) return;
      boxDrag = false;
      map.dragging.enable();
    };
    el.addEventListener('mousedown', dn, true);
    el.addEventListener('mousemove', mv, true);
    window.addEventListener('mouseup', up, true);
    boxRef.current = rect;

    return () => {
      map.off('move', onMove);
      el.removeEventListener('mousedown', dn, true);
      el.removeEventListener('mousemove', mv, true);
      window.removeEventListener('mouseup', up, true);
      if (boxDrag) map.dragging.enable();
      el.style.cursor = '';
      map.removeLayer(rect);
      if (cross.parentNode) cross.parentNode.removeChild(cross);
      map.scrollWheelZoom.enable();
      map.doubleClickZoom.enable();
      if (map.touchZoom) map.touchZoom.enable();
      if (map.boxZoom) map.boxZoom.enable();
    };
  }, [dragging, map]);

  const fmtB = (b) => b.map((v) => (+v).toFixed(5)).join(', ');
  const useView = () => {
    const b = map.getBounds();
    setBbox([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
    setStatus('box = current view');
  };

  const doOsm = async () => {
    setStatus('fetching OSM…');
    try {
      const url = osmApiUrl(bbox);
      const r = await fetch(url);
      if (!r.ok) throw new Error('OSM HTTP ' + r.status);
      let xml = await r.text();
      /* stamp the current map zoom as a comment so convert.sh can carry it
       * into the .net.xml — parseNetXml reads it back as suggestedZoom and
       * the entry auto-snaps at that zoom on open/publish. */
      const tag = '<!-- simo:zoom=' + Math.round(map.getZoom()) + ' -->';
      if (/<bounds\b[^>]*\/>/.test(xml)) {
        xml = xml.replace(/(<bounds\b[^>]*\/>)/, '$1\n' + tag);
      } else {
        xml = xml.replace(/<\/osm>/, tag + '\n</osm>');
      }
      downloadText((name.current || 'area') + '.osm.xml', xml, 'text/xml');
      setStatus('.osm.xml downloaded — now grab convert.sh');
    } catch (e) {
      setStatus('fetch failed: ' + e.message + ' (OSM may rate-limit big areas)');
    }
  };
  const doScript = () => {
    downloadText('convert.sh', convertScript(bbox, name.current), 'text/x-sh');
    setStatus('convert.sh downloaded — run it next to the .osm.xml');
  };

  /* minimized box-draw mode */
  if (dragging) {
    return h('div', { className: 'anchor-bar' },
      h('div', { className: 'ab-step' }, 'EXPORT AREA'),
      h('div', { className: 'ab-body' },
        h('span', { className: 'num' }, fmtB(bbox)),
        h('div', { className: 'hint', style: { margin: '4px 0 0' } },
          'Pan the map — the box stays on the crosshair. '
          + 'Drag the box to fine-position.')),
      h('div', { className: 'ab-row' },
        h('button', { className: 'ghost', onClick: () => setDragging(false) },
          'Show form'),
        h('button', { className: 'ghost', onClick: onClose }, 'Cancel')));
  }

  return h('div', {
    className: 'modal-veil',
    onClick: (ev) => { if (ev.target === ev.currentTarget) onClose(); },
  },
    h('div', { className: 'modal' },
      h('div', { className: 'step' }, 'EXPORT AREA FOR SUMO'),
      h('h3', null, 'Get the real road network'),
      h('div', { className: 'hint' },
        'Download the OpenStreetMap roads for a box, then run convert.sh '
        + '(auto-finds netconvert) to make a SUMO .net.xml you upload here.'),
      h('input', {
        type: 'text', defaultValue: name.current, placeholder: 'area name',
        onChange: (ev) => { name.current = ev.target.value || 'area'; },
        style: { margin: '6px 0' },
      }),
      h('div', { className: 'fld', style: { padding: '6px 0' } },
        h('label', null, 'BOX'),
        h('span', { className: 'val num' }, fmtB(bbox))),
      h('div', { className: 'row', style: { justifyContent: 'flex-start' } },
        h('button', { className: 'ghost', onClick: useView }, 'Use current view'),
        h('button', { className: 'ghost', onClick: () => setDragging(true) },
          'Draw a box')),
      h('div', { className: 'row' },
        h('button', { className: 'ghost', onClick: onClose }, 'Cancel'),
        h('button', { className: 'ghost', onClick: doScript }, 'convert.sh'),
        h('button', { onClick: doOsm }, 'Download .osm.xml')),
      status ? h('div', { className: 'hint' }, status) : null));
}

// <SUBMIT_FLOW> -----------------------------------------------------------
function SubmitFlow({ store }) {
  const map = React.useContext(MapProvider);
  const d = store.draftSub;
  const [step, setStep] = React.useState(0);
  const [reject, setReject] = React.useState('');
  const [over, setOver] = React.useState(false);
  /* steps 3/4 minimize the modal so the map is usable — but only after the
   * user explicitly asks via the preamble modal's CTA */
  const [minimized, setMinimized] = React.useState(false);

  /* step 3: click the map to drop the anchor pin. Registered at the map
   * container in the CAPTURE phase so it fires before any Leaflet layer
   * (zones, pins, markers) can stopPropagation on the click. Leaflet chrome
   * (zoom controls, attribution) sits inside the same container, so those
   * clicks must be excluded or they'd re-place the pin. */
  React.useEffect(() => {
    if (!map || step !== 3 || !minimized) return undefined;
    const h = (ev) => {
      if (ev.target.closest && ev.target.closest(
        '.anchor-bar, .leaflet-control, .leaflet-popup, .leaflet-tooltip')) {
        return;
      }
      const ll = map.mouseEventToLatLng(ev);
      store.placeDraft([+ll.lat.toFixed(5), +ll.lng.toFixed(5)]);
    };
    const el = map.getContainer();
    el.addEventListener('click', h, true);
    return () => { el.removeEventListener('click', h, true); };
  }, [map, step, minimized, store.placeDraft]);

  /* live geometry preview: paint parsed .net.xml lanes on the map overlay
   * during the anchor + rotation steps so the user sees the network rotate
   * and position in real geography. Cleared on every other step/unmount. */
  const overlay = React.useContext(MapOverlayProvider);
  const lat = d.latlng && d.latlng[0], lng = d.latlng && d.latlng[1];
  /* Always have something to show: fall back to the placeholder cross when
   * no .net.xml was parsed, so the rotation preview is never empty. */
  const previewGeo = d.geo
    || (defaultSimMeta(d).scenarios.today.lanes.length
      ? { lanes: defaultSimMeta(d).scenarios.today.lanes } : null);
  React.useEffect(() => {
    if (!overlay) return undefined;
    if ((step === 3 && d.latlng) || step === 4) {
      overlay.setDraft(previewGeo, d.latlng, d.rotation || 0);
    } else {
      overlay.clearDraft();
    }
    return () => { overlay.clearDraft(); };
  }, [overlay, step, minimized, lat, lng, d.rotation, d.geo]);

  /* geo-locked nets take their orientation from the map bounds, so the
   * rotation is pinned to 0 when the rotation step is entered. */
  React.useEffect(() => {
    if (step === 4 && d.geo && d.geo.geoLocked && (d.rotation || 0) !== 0) {
      store.updateDraft({ rotation: 0 });
    }
  }, [step, d.geo, d.rotation, store.updateDraft]);

  /* draggable marker at the chosen anchor (steps 3-5) */
  const latlngKey = d.latlng ? d.latlng.join(',') : '';
  React.useEffect(() => {
    if (!map || !d.latlng) return undefined;
    const mk = L.marker(d.latlng, { draggable: true });
    mk.on('dragend', () => {
      const ll = mk.getLatLng();
      store.placeDraft([+ll.lat.toFixed(5), +ll.lng.toFixed(5)]);
    });
    mk.addTo(map);
    return () => { map.removeLayer(mk); };
  }, [map, latlngKey, store.placeDraft]);

  const addFiles = (list) => {
    const arr = Array.from(list || []);
    const good = [];
    let bad = '';
    for (const f of arr) {
      const c = classifyUploadFile(f.name, f.size);
      if (c) good.push(c); else bad = f.name;
    }
    if (good.length) store.updateDraft({ files: (d.files || []).concat(good) });
    setReject(bad
      ? bad + ' — unsupported extension (.rou.xml / .net.xml / .sumocfg only)'
      : '');
    /* parse the first .net.xml into real geometry for the live preview */
    const netFile = arr.find((f) => /\.net\.xml$/i.test(f.name));
    if (netFile && typeof FileReader !== 'undefined') {
      const rd = new FileReader();
      rd.onload = () => {
        const geo = parseNetXml(String(rd.result || ''));
        if (geo) {
          store.setDraftGeo(geo);
          /* geo-locked net: anchor pre-filled from the downloaded bounds */
          if (geo.geoLocked) store.placeDraft(geo.anchor);
        }
        else setReject(netFile.name + ' — parsed 0 lanes (not a SUMO net?)');
      };
      rd.readAsText(netFile);
    }
  };

  const canNext = [
    d.username.trim().length > 0,
    (d.files || []).length > 0,
    d.title.trim().length > 0,
    !!d.latlng,
    true,
    false,
  ][step];

  let body = null;
  if (step === 0) {
    body = [
      h('h3', { key: 't' }, 'Pick a username'),
      h('div', { key: 'h', className: 'hint' },
        'Shown as the author. Google sign-in replaces this later — '
        + 'for now it is just a name.'),
      h('input', {
        key: 'i', type: 'text', placeholder: 'e.g. balagere-traffic',
        value: d.username, autoFocus: true,
        onChange: (ev) => store.updateDraft({ username: ev.target.value }),
      }),
    ];
  } else if (step === 1) {
    body = [
      h('h3', { key: 't' }, 'Upload the SUMO bundle'),
      h('div', { key: 'h', className: 'hint' },
        'Pre-packed export: geometry, 1 Hz positions, phases, stats. '
        + 'Accepts .rou.xml / .net.xml / .sumocfg.'),
      h('div', {
        key: 'dz', className: 'dropzone' + (over ? ' over' : ''),
        onDragOver: (ev) => { ev.preventDefault(); setOver(true); },
        onDragLeave: () => setOver(false),
        onDrop: (ev) => {
          ev.preventDefault();
          setOver(false);
          addFiles(ev.dataTransfer.files);
        },
      }, 'drop files here, or choose below'),
      h('input', {
        key: 'f', type: 'file', multiple: true,
        onChange: (ev) => addFiles(ev.target.files),
      }),
      h('div', { key: 'c', className: 'chips' },
        (d.files || []).map((f, i) => h('span', { className: 'chip', key: i },
          h('b', null, f.kind.toUpperCase()),
          ' ' + f.name + ' · ' + (f.size / 1024).toFixed(1) + ' KB'))),
      reject ? h('div', { key: 'r', className: 'reject' }, reject) : null,
    ];
  } else if (step === 2) {
    body = [
      h('h3', { key: 't' }, 'Name it'),
      h('input', {
        key: 'ti', type: 'text',
        placeholder: 'e.g. Kundalahalli peak U-turn ban', value: d.title,
        onChange: (ev) => store.updateDraft({ title: ev.target.value }),
      }),
      h('textarea', {
        key: 'ta', rows: 3, placeholder: 'What does this simulation show?',
        value: d.desc,
        onChange: (ev) => store.updateDraft({ desc: ev.target.value }),
      }),
    ];
  } else {
    body = [
      h('h3', { key: 't' }, 'Review'),
      h('div', { key: 'rv', className: 'review' }, [
        h('b', { key: 'a' }, 'AUTHOR'), h('span', { key: 'av' }, d.username),
        h('b', { key: 'f' }, 'FILES'),
        h('span', { key: 'fv' }, (d.files || []).map((f) => f.name).join(', ')),
        h('b', { key: 't' }, 'TITLE'), h('span', { key: 'tv' }, d.title),
        h('b', { key: 'an' }, 'ANCHOR'),
        h('span', { key: 'anv', className: 'num' },
          d.latlng ? d.latlng.join(', ') : '—'),
        h('b', { key: 'r' }, 'ROTATION'),
        h('span', { key: 'rv2', className: 'num' }, (d.rotation || 0) + '°'),
      ]),
      h('div', { key: 'h', className: 'hint' },
        'Moderation is assumed in this mockup — submitting publishes '
        + 'straight onto the map.'),
    ];
  }

  /* Anchoring + rotation steps. Two presentations:
   * - preamble: the normal modal explains what to do, with a CTA that
   *   minimizes it (map placement is only armed while minimized);
   * - minimized: a bottom bar keeps the map fully interactive
   *   (pan / zoom / click-to-place / drag pin / rotate with live preview). */
  if ((step === 3 || step === 4) && minimized) {
    return h('div', { className: 'anchor-bar' },
      h('div', { className: 'ab-step' },
        'SUBMIT · STEP ' + (step + 1) + '/6'),
      h('div', { className: 'ab-body' },
        step === 3
          ? (d.latlng
            ? h('span', { className: 'num' },
              d.latlng[0].toFixed(5) + ', ' + d.latlng[1].toFixed(5))
            : 'Pan / zoom the map, then click to drop the anchor pin')
          : (d.geo && d.geo.geoLocked
            ? h('span', null,
              'Rotation locked — the map bounds set the orientation.')
            : h('span', { className: 'fld', style: { padding: 0 } },
              h('label', null, 'ROT'),
              h('input', {
                type: 'range', min: -45, max: 45, step: 1,
                value: d.rotation || 0,
                onInput: (ev) => store.updateDraft(
                  { rotation: parseInt(ev.target.value, 10) || 0 }),
              }),
              h('span', { className: 'val' }, (d.rotation || 0) + '°')))),
      h('div', { className: 'ab-row' },
        h('button', { className: 'ghost', onClick: () => setMinimized(false) },
          'Show instructions'),
        h('button', { className: 'ghost', onClick: store.cancelDraft },
          'Cancel'),
        step === 3 && !d.latlng
          ? null
          : h('button', {
            onClick: () => { setMinimized(false); setStep(step + 1); },
          }, step === 3 ? 'Confirm anchor' : 'Confirm rotation')));
  }

  /* preamble bodies for the map-interactive steps (full modal) */
  if (step === 3) {
    body = [
      h('h3', { key: 't' }, 'Anchor it to the map'),
      h('div', { key: 'h', className: 'hint' },
        "The simulation's local origin sits at this point. Next you will "
        + 'pick the spot on the map: the window minimizes so you can pan '
        + 'and zoom freely, then click to drop the pin and drag it to '
        + 'fine-tune. Confirm when the pin sits on the junction.'),
      d.geo && d.geo.geoLocked
        ? h('div', { key: 'gl', className: 'hint' },
          'Position locked to the downloaded map bounds — '
          + 'no manual anchoring needed')
        : null,
      d.latlng
        ? h('div', { key: 'll', className: 'hint num' },
          'current anchor: '
          + d.latlng[0].toFixed(5) + ', ' + d.latlng[1].toFixed(5))
        : null,
    ];
  } else if (step === 4) {
    body = [
      h('h3', { key: 't' }, 'Rotate the network'),
      h('div', { key: 'h', className: 'hint' },
        "Match the bundle's orientation to the real road — degrees clockwise "
        + 'from north-aligned. The window minimizes so you can watch the '
        + 'preview turn on the map while you drag the slider.'),
    ];
  }

  return h('div', {
    className: 'modal-veil',
    onClick: (ev) => { if (ev.target === ev.currentTarget) store.cancelDraft(); },
  },
    h('div', { className: 'modal' },
      h('div', { className: 'step' },
        'SUBMIT A SIMULATION · STEP ' + (step + 1) + '/6'),
      h('div', { key: step, className: 'flip-step' }, body),
      h('div', { className: 'row' },
        h('button', { className: 'ghost', onClick: store.cancelDraft }, 'Cancel'),
        step > 0
          ? h('button', {
            className: 'ghost',
            onClick: () => { setMinimized(false); setStep(step - 1); },
          }, 'Back') : null,
        step === 3 || step === 4
          ? h('button', { onClick: () => setMinimized(true) },
            step === 3 ? 'Minimize & select location' : 'Minimize & rotate')
          : step < 5
            ? h('button', {
              disabled: !canNext, onClick: () => setStep(step + 1),
            }, 'Next')
            : h('button', { onClick: store.submitDraft },
              'Submit for review'))));
}

/* App-only styles on top of BALAGERE_CSS_STYLE (dark tokens stay there). */
const EXTRA_CSS = ''
  + '.map-el{position:absolute;inset:0}\n'
  + '@keyframes flipIn{from{transform:perspective(700px) rotateY(7deg);'
  + 'opacity:0}to{transform:none;opacity:1}}\n'
  + '.flip-step{animation:flipIn .28s ease both}\n'
  + '.dropzone{margin:10px 0;padding:24px;border:1px dashed var(--hair);'
  + 'border-radius:5px;text-align:center;color:var(--ink3);font-size:12.5px}\n'
  + '.dropzone.over{border-color:var(--accent);color:var(--ink)}\n'
  + '.fld{display:flex;align-items:center;gap:9px;font-size:12px;'
  + 'color:var(--ink3);padding:7px 18px}\n'
  + '.fld label{letter-spacing:.08em;font-weight:600;font-size:10.5px;'
  + 'min-width:48px}\n'
  + '.fld input[type=range]{flex:1;accent-color:var(--accent)}\n'
  + '.fld .val{font-family:var(--mono);font-size:12.5px;color:var(--ink);'
  + 'min-width:52px;text-align:right;font-variant-numeric:tabular-nums}\n'
  + '.sheet .closex{position:absolute;top:10px;right:12px;min-width:0;'
  + 'padding:4px 10px}\n'
  + '.modal textarea{width:100%;background:var(--surface2);'
  + 'border:1px solid var(--hair);border-radius:3px;color:var(--ink);'
  + 'font:inherit;font-size:13px;padding:8px 10px;margin:6px 0;resize:vertical}\n'
  + '.modal input[type=file]{color:var(--ink3);font-size:12px;margin:6px 0}\n'
  + '.modal .row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}\n'
  + '.modal button[disabled]{opacity:.45;cursor:not-allowed}\n'
  + '.reject{font-size:11.5px;color:var(--red);margin:4px 0}\n'
  + '.hint{font-size:11.5px;color:var(--ink3);margin:8px 0}\n'
  + '.review{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;'
  + 'font-size:12.5px;color:var(--ink2);margin:10px 0}\n'
  + '.review b{color:var(--ink3);font-weight:600;letter-spacing:.08em;'
  + 'font-size:10px}\n'
  + '.leaflet-tooltip.sim-tt{background:rgba(23,23,26,.94);'
  + 'border:1px solid var(--hair);color:var(--ink);font-family:var(--body);'
  + 'font-size:11.5px;box-shadow:0 8px 22px rgba(0,0,0,.5)}\n'
  + '.leaflet-tooltip-top.sim-tt:before{border-top-color:var(--hair)}\n'
  + '.sim-canvas{position:absolute;top:0;left:0;z-index:640;pointer-events:none}\n'
  + '/* minimized anchor/rotation bar: modal-veil is gone while this shows,\n'
  + '   so the map underneath stays fully pannable / zoomable / clickable */\n'
  + '.anchor-bar{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);\n'
  + '  z-index:900;display:flex;align-items:center;gap:14px;background:var(--surface);\n'
  + '  border:1px solid var(--hair);border-radius:6px;padding:10px 14px;\n'
  + '  box-shadow:0 10px 30px rgba(0,0,0,.55);max-width:min(720px,92%)}\n'
  + '.anchor-bar .ab-step{font-family:var(--mono);font-size:10px;\n'
  + '  letter-spacing:.14em;color:var(--ink3);white-space:nowrap}\n'
  + '.anchor-bar .ab-body{flex:1;font-size:12.5px;color:var(--ink2);\n'
  + '  min-width:180px}\n'
  + '.anchor-bar .ab-body .num{font-family:var(--mono);color:var(--ink);\n'
  + '  font-variant-numeric:tabular-nums}\n'
  + '.anchor-bar .ab-row{display:flex;gap:8px}\n'
  + '.anchor-bar button{min-width:0;padding:8px 14px}\n'
  + '.anchor-bar .fld{flex:1}\n'
  + '/* export draw mode: crosshair pinned to the map container center,\n'
  + '   above .sim-canvas (640), below .anchor-bar (900) */\n'
  + '.export-crosshair{position:absolute;left:50%;top:50%;width:0;height:0;\n'
  + '  z-index:800;pointer-events:none}\n'
  + '.export-crosshair i{position:absolute;display:block;background:#E50914}\n'
  + '.export-crosshair .ch{left:-10px;top:-0.75px;width:20px;height:1.5px}\n'
  + '.export-crosshair .cv{top:-10px;left:-0.75px;width:1.5px;height:20px}\n'
  + '/* loading screen: covers the map area until the first tile load */\n'
  + '.loader{position:absolute;inset:0;z-index:1200;background:var(--ground);\n'
  + '  display:flex;flex-direction:column;align-items:center;\n'
  + '  justify-content:center;gap:16px}\n'
  + '.loader .mark{font-size:15px}\n'
  + '.loader .spin{width:30px;height:30px;border-radius:50%;\n'
  + '  border:3px solid var(--hair);border-top-color:var(--accent);\n'
  + '  animation:simospin .8s linear infinite}\n'
  + '@keyframes simospin{to{transform:rotate(360deg)}}\n'
  + '.loader .msg{font-size:12.5px;color:var(--ink3);letter-spacing:.04em}\n';

/* Bootstrap — gated so the Node vm tests can load the head with no DOM. */
if (typeof document !== 'undefined') {
  const __simoStyle = document.createElement('style');
  __simoStyle.textContent = BALAGERE_CSS_STYLE + EXTRA_CSS;
  document.head.appendChild(__simoStyle);
  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
}



