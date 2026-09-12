/* Geometry helpers: deterministic pseudo-geometry for sims without a real
 * stream, map placement scale, UTM inverse, geo-locked sim->WGS84 mapping.
 * Ported verbatim from the app.js pure head. */

/* Deterministic pseudo-geometry helpers for sims without a real stream. */
export function laneProfile(lanes) {
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

export function pointOnLane(prof, dist) {
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

/* px per metre at (lat, zoom), clamped so geometry never collapses when the
 * map is zoomed out (LATM min-scale, plan decision table). */
export function placementScale(lat, zoom) {
  return Math.max(
    Math.pow(2, zoom) / (156543.03392 * Math.cos(lat * Math.PI / 180)),
    2.5
  );
}

/* ---------------------------------------------------------- utmToLatLng
 * Standard USGS transverse-Mercator inverse (WGS84 ellipsoid): UTM easting/
 * northing (metres) + zone -> [latDeg, lngDeg]. This is the exact inverse of
 * the projection netconvert applied, so a UTM net's sim coords (which are
 * utm + netOffset) land back on their true WGS84 positions to <1 cm. */
export function utmToLatLng(E, N, zone, south) {
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
export function simToLatLng(geo, xDm, yDm) {
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

/* ~40 m square around [lat,lng] — default zone for fresh submissions. */
export function defaultZonePoly(latlng) {
  const lat = latlng[0], lng = latlng[1];
  const dLat = 20 / 111320;                              // 20 m half-side
  const dLng = 20 / (111320 * Math.cos(lat * Math.PI / 180) || 1);
  return [
    [lat - dLat, lng - dLng], [lat - dLat, lng + dLng],
    [lat + dLat, lng + dLng], [lat + dLat, lng - dLng],
  ];
}
