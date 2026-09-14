/* Canvas overlay + playback helpers. Ported verbatim from app.js (below the
 * pure-region marker). react/leaflet live here, never in src/lib. */
import L from 'leaflet';
import { TrafficSimEngine } from '../lib/engine.js';
import { simToLatLng, placementScale } from '../lib/geo.js';
import { zoomCanvasTransform } from './zoomTransform.js';

/* Canvas colors read the theme tokens (EXTRA_CSS :root) — canvas paints
 * cannot use var(), so resolve them once. Never cached when there is no
 * DOM (node tests): speedColor returns '' and nothing draws. */
let THEME = null;
function theme() {
  if (THEME) return THEME;
  if (typeof document === 'undefined'
      || typeof getComputedStyle !== 'function') return {};
  const s = getComputedStyle(document.documentElement);
  const v = (n) => (s.getPropertyValue(n) || '').trim();
  const rgb = (n) => {
    const m = /^#([0-9a-f]{6})$/i.exec(v(n));
    return m
      ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16),
        parseInt(m[1].slice(4, 6), 16)]
      : null;
  };
  THEME = {
    roadCore: v('--road-core'), roadCasing: v('--road-casing'),
    draftCasing: v('--draft-casing'), accent: v('--accent'),
    accentInk: v('--accent-ink'), accentDim: v('--accent-dim'),
    green: v('--green'), greenDim: v('--green-dim'), amber: v('--amber'),
    off: v('--ink3'), ground: v('--ground'), arm: v('--today'),
    greenC: rgb('--green'), amberC: rgb('--amber'), redC: rgb('--red'),
  };
  return THEME;
}
export const VEH_TYPES = [[4.5, 1.8], [2.1, 0.8], [12, 2.5], [7.5, 2.4], [3.2, 1.5]];

export function lerpC(a, b, t) {
  return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')';
}
export function speedColor(v) {                    // red -> amber -> green by m/s
  const C = theme();
  if (!C.greenC || !C.amberC || !C.redC) return '';
  if (v <= 0.4) return lerpC(C.redC, C.redC, 0);
  if (v < 3.5) return lerpC(C.redC, C.amberC, (v - 0.4) / 3.1);
  if (v < 8) return lerpC(C.amberC, C.greenC, (v - 3.5) / 4.5);
  return lerpC(C.greenC, C.greenC, 0);
}
export function phaseAt(ph, t) {
  if (!ph || !ph.length) return null;
  const cyc = ph.reduce((s, p) => s + p[0], 0);
  let u = t % cyc, a = 0;
  for (const [d, st] of ph) { a += d; if (u < a) return st; }
  return ph[ph.length - 1][1];
}
export function fmtStat(v) {                       // mono, 4-digit clamp with '+'
  v = Math.max(0, Math.round(v));
  return v >= 9999 ? '9,999+' : v.toLocaleString();
}
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Create engine for an entry. If the entry's scenario has frames (base64 BLGR),
 * TrafficSimEngine will decode them; otherwise it synthesises vehicles from lanes. */
export function engineFor(entry) {
  return new TrafficSimEngine(null, entry, entry.id);
}
export function scenarioGeoOf(entry, scenKey) {
  if (entry && entry.scenarios) {
    return entry.scenarios[scenKey] || entry.scenarios.today
      || entry.scenarios[Object.keys(entry.scenarios)[0]] || null;
  }
  return null;
}

/* Lazy-load a per-sim stream payload via script injection.
 * Streams live at streams/<id>.js (public/, so the relative URL resolves in
 * dev and build) and call window.__simoStreamCallback(id, payload).
 * JSONP is kept — it worked on file:// and the format is locked by tests. */
export function loadSimStream(simId, callback) {
  const url = 'streams/' + simId + '.js';
  const script = document.createElement('script');
  script.src = url;
  script.async = true;
  window.__simoStreamCallback = function (id, payload) {
    if (id === simId) {
      callback(payload);
      delete window.__simoStreamCallback;
    }
  };
  script.onerror = function () {
    callback(null);
    delete window.__simoStreamCallback;
  };
  document.head.appendChild(script);
}

/* Canvas overlay on the Leaflet overlay pane. Owns one <canvas> sized to the
 * map; redraws on moveend/zoomend/resize/move and on setTime (RAF-coalesced).
 * During Leaflet's 250ms animated zoom the canvas raster-scales to the
 * zoomanim target (translate3d/scale via zoomCanvasTransform + DomUtil
 * .setTransform, the L.Renderer technique — the canvas is a container child
 * and gets no pane transform), and the next draw resets the transform and
 * repaints crisp at the settled zoom.
 * Placement: sim dm -> m (/10), rotate by entry.rotation, metres -> px via
 * placementScale (2.5 px/m floor keeps roads visible at low zoom), origin at
 * latLngToLayerPoint(anchor) - getPixelOrigin(). */
export function makeSimOverlay(map) {
  let entry = null, scenKey = 'today', simT = 0;
  let draft = null;         // {geo, latlng, rotation} — live submit preview
  let eng = null, canvas = null, g = null, rafId = 0;
  /* last-drawn view state for the zoomanim raster-scale (zoomTransform.js):
   * what the canvas currently shows, not map.getZoom() — that already holds
   * the TARGET zoom once a zoom animation starts. */
  let paintedZoom = null, paintedOrigin = null;
  let zoomScaled = false;   // a zoomanim raster-scale transform is applied

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
    if (zoomScaled) {
      /* the zoom animation settled (first move/zoomend fired): drop the
       * raster-scale and repaint crisp at the new view */
      zoomScaled = false;
      canvas.style.transition = '';
      canvas.style.transform = '';
    }
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
    /* the canvas now shows exactly this view — remember it for onZoomAnim */
    paintedZoom = map.getZoom();
    paintedOrigin = map.getPixelOrigin();
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
      const T = theme();
      g.save();
      g.globalAlpha = 0.9;
      for (const pass of [0, 1]) {
        g.strokeStyle = pass ? T.accentInk : T.draftCasing;
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
      g.strokeStyle = T.accent;
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
        g.strokeStyle = T.accentDim;
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

    // roads: casing pass, then core pass (build_player idiom)
    const lanes = geo.lanes || [];
    const T = theme();
    for (const pass of [0, 1]) {
      g.strokeStyle = pass ? T.roadCore : T.roadCasing;
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
      const col = { 3: T.green, 2: T.greenDim, 1: T.amber, 0: T.off };
      const stops = geo.stops || {}, links = geo.links || {};
      for (const frm of Object.keys(stops)) {
        const idx = links[frm] || [];
        let b = 0;
        for (const k of idx) b = Math.max(b, rank[st[k]] != null ? rank[st[k]] : 0);
        const [X, Y] = toPx(stops[frm][0], stops[frm][1]);
        g.fillStyle = col[b];
        g.strokeStyle = T.ground;
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
    g.font = '700 11px Inter, "Helvetica Neue", Helvetica, Arial, sans-serif';
    g.fillStyle = T.arm;
    g.textAlign = 'center';
    for (const name of Object.keys(arms)) {
      const [X, Y] = toPx(arms[name][0], arms[name][1]);
      g.fillText(name, Math.min(Math.max(X, 44), size.x - 44),
        Math.min(Math.max(Y, 14), size.y - 8));
    }
  }

  /* Animated zoom: Leaflet fires zoomanim once with the target {center, zoom}
   * and CSS-transitions the map pane over 250ms while suppressing move
   * events. The canvas is a container child (no pane transform), so scale
   * the last painted frame to the target here — the same raster-scale trick
   * as L.Renderer — and let draw() reset it once the view settles. */
  function onZoomAnim(e) {
    if (!canvas || paintedZoom == null || !paintedOrigin) return;
    const c = map.project(e.center, e.zoom);
    const size = map.getSize();
    const t = zoomCanvasTransform(size.x, size.y, paintedZoom,
      paintedOrigin.x, paintedOrigin.y, c.x, c.y, e.zoom);
    canvas.style.transition = 'transform 0.25s cubic-bezier(0,0,0.25,1)';
    L.DomUtil.setTransform(canvas, { x: t.offsetX, y: t.offsetY }, t.scale);
    zoomScaled = true;
  }

  const SimLayer = L.Layer.extend({
    onAdd: function () {
      canvas = L.DomUtil.create('canvas', 'sim-canvas');
      canvas.style.pointerEvents = 'none';
      canvas.style.position = 'absolute';
      canvas.style.top = '0';
      canvas.style.left = '0';
      /* transform origin 0 0 = what the leaflet-zoom-animated class does:
       * zoomanim raster-scales around the viewport top-left (zoomTransform
       * math is in container coords). */
      canvas.style.transformOrigin = '0 0';
      /* append to the map CONTAINER (not a pane): the canvas covers the
       * viewport and never moves with pan, so latLngToContainerPoint()
       * (screen px) aligns with it exactly — no pane-offset compensation. */
      this._map.getContainer().appendChild(canvas);
      g = canvas.getContext('2d');
      this._map.on('moveend zoomend resize move', requestDraw);
      this._map.on('zoomanim', onZoomAnim);
      requestDraw();
    },
    onRemove: function () {
      this._map.off('moveend zoomend resize move', requestDraw);
      this._map.off('zoomanim', onZoomAnim);
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
