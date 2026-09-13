/* Area export helpers. The pure head shared by the client and the server:
 * osmApiUrl builds the OSM /api/0.6/map request the SERVER now performs
 * (POST /api/export-net fetches OSM, runs netconvert, returns a finished
 * .net.xml); validateBbox + sanitizeAreaName gate that request. */

/* bbox = [minLat, minLng, maxLat, maxLng] ->
 * OSM bbox=minLng,minLat,maxLng,maxLat */
export function osmApiUrl(bbox) {
  const b = bbox.map((v) => +(+v).toFixed(6));
  return 'https://www.openstreetmap.org/api/0.6/map?bbox='
    + b[1] + ',' + b[0] + ',' + b[3] + ',' + b[2];
}

/* Server-side bbox gate (error string | null): shape, finite numbers, lat
 * [-90,90] / lng [-180,180], min < max on both axes, and each side <=
 * 0.25° — the OSM /api/0.6/map hard cap (a bigger box always 400s
 * upstream; rejecting here keeps that from surfacing as a generic 502).
 * 1e-9 slack absorbs float drift at exactly-0.25 boxes. */
export function validateBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return 'bbox must be [minLat, minLng, maxLat, maxLng]';
  }
  if (!bbox.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return 'bbox entries must all be finite numbers';
  }
  const [minLat, minLng, maxLat, maxLng] = bbox;
  if (minLat < -90 || maxLat > 90) return 'lat must be within [-90, 90]';
  if (minLng < -180 || maxLng > 180) return 'lng must be within [-180, 180]';
  if (minLat >= maxLat || minLng >= maxLng) {
    return 'bbox must satisfy min < max on both axes';
  }
  if (maxLat - minLat > 0.25 + 1e-9 || maxLng - minLng > 0.25 + 1e-9) {
    return 'each bbox side must be <= 0.25 degrees (the OSM /api/0.6/map '
      + 'hard cap) — draw a smaller area';
  }
  return null;
}

/* The convert.sh slug regex: every run of characters outside
 * [a-z0-9-] becomes one dash; empty/missing -> 'area'. */
export function sanitizeAreaName(name) {
  return (name || 'area').replace(/[^a-z0-9-]+/g, '-');
}
