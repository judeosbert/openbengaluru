/* SUMO .net.xml parsing and upload classification. Ported verbatim from the
 * app.js pure head. Under Node (no DOMParser) parseNetXml runs its regex
 * fallback path — same coverage as the old vm harness. */

/* --------------------------------------------------- upload file classifier
 * Slot contract: .rou.xml -> routes (DEMAND), .net.xml -> network (net
 * slots); both case-insensitive. .sumocfg is NOT part of a complete input
 * set (demand + net(s) is) — rejected like anything else -> null. */
export function classifyUploadFile(name, size) {
  const n = String(name == null ? '' : name);
  const lower = n.toLowerCase();
  let kind = null;
  if (/\.rou\.xml$/.test(lower)) kind = 'routes';
  else if (/\.net\.xml$/.test(lower)) kind = 'network';
  else return null;
  return { name: n, size: Math.max(0, size | 0), kind };
}

/* Demand count from a SUMO .rou.xml: every <trip>/<vehicle> open tag adds 1;
 * a <flow> adds its numeric vehsPerHour= or number= attribute when present,
 * else 1. Regex-based, DOM-free (same style as the parseNetXml fallback). */
export function parseDemandCount(xmlText) {
  if (!xmlText || typeof xmlText !== 'string') return 0;
  let count = 0;
  const tag = (name) => {
    const re = new RegExp('<' + name + '(?=[\\s>])[^>]*>', 'gi');
    let m;
    while ((m = re.exec(xmlText))) {
      const attrs = m[0];
      let v = NaN;
      const vh = /vehsPerHour\s*=\s*"(-?[\d.]+)"/.exec(attrs)
        || /number\s*=\s*"(-?[\d.]+)"/.exec(attrs);
      if (vh) v = parseFloat(vh[1]);
      count += isFinite(v) && v > 0 ? Math.round(v) : 1;
    }
  };
  tag('trip');
  tag('vehicle');
  tag('flow');
  return count;
}

/* ---------------------------------------------------------- parseNetXml
 * SUMO .net.xml -> player geometry {lanes, arms, phases, stops, links}.
 * Lane shapes are metres in the net file; output is decimetres (dm) like
 * build_player's geom(). Uses DOMParser in the browser, a regex fallback
 * under the Node test harness (no DOM there). Returns null on no lanes. */
export function parseNetXml(xmlText) {
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
