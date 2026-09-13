/* Animated-zoom raster-scale math for the sim canvas overlay (pure numbers,
 * no leaflet/DOM — importable in the node vitest env). Locked by
 * test/overlay-zoom.test.js.
 *
 * The canvas paints container points for the last-drawn (painted) view:
 * painted container point p  <->  world px p + paintedOrigin. A zoomanim
 * target view (targetZoom around targetCenterPoint, the crs-projected
 * target center) draws that same world px at
 *   p' = (p + paintedOrigin) * scale - targetOrigin
 * with scale = 2^(targetZoom - paintedZoom) and
 *   targetOrigin = targetCenterPoint - size/2
 * (Leaflet pixelOrigin identity: project(center, zoom) - size/2).
 * Rearranged: p' = scale * p + offset, offset = paintedOrigin * scale -
 * targetOrigin — a single translate3d + scale() transform that glues the
 * last painted frame to the tiles for the 250ms zoom animation, the same
 * technique as L.Renderer / L.ImageOverlay.
 *
 * The caller passes the PAINTED state (recorded at draw time), not
 * map.getZoom() at zoomanim time — map._zoom already holds the target zoom
 * once the animation starts, and a newer animation may be interrupting an
 * older one. */
export function zoomCanvasTransform(sizeX, sizeY, paintedZoom,
    paintedOriginX, paintedOriginY, targetCenterPointX, targetCenterPointY,
    targetZoom) {
  const scale = Math.pow(2, targetZoom - paintedZoom);
  return {
    scale,
    offsetX: paintedOriginX * scale - (targetCenterPointX - sizeX / 2),
    offsetY: paintedOriginY * scale - (targetCenterPointY - sizeY / 2),
  };
}