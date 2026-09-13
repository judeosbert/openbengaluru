/* Anchor pins layer. Ported verbatim from app.js minus the zone polygons
 * (removed — the colored rectangle around each entry added clutter).
 * divIcons land in the marker pane (z 620 in BALAGERE_CSS_STYLE) — above
 * the tile pane (200), below the popup pane (660). */
import React from 'react';
import L from 'leaflet';
import { escapeHtml } from './overlay.js';

export const PIN_ZOOM = 12.5;      // below: centroid badges only; at/above: pins too

/* One useEffect-managed L.layerGroup: divIcon pins/badges per catalog
 * entry, anchored at the zonePoly centroid (zoomed out) or the real anchor
 * (zoomed in). */
export function ZonesAndPins({ map, catalog, activeSimId, onViewSim }) {
  const [zoom, setZoom] = React.useState(() => map.getZoom());

  React.useEffect(() => {
    const onZ = () => setZoom(map.getZoom());
    map.on('zoomend', onZ);
    return () => { map.off('zoomend', onZ); };
  }, [map]);

  const bucket = zoom >= PIN_ZOOM;

  React.useEffect(() => {
    const grp = L.layerGroup().addTo(map);

    catalog.forEach((e) => {
      const hasBoth = !!(e.scenarios && e.scenarios.today && e.scenarios.proposed);
      const badgeCol = hasBoth ? '#35C46B' : '#4E8DD9';   // PROPOSED green / TODAY blue

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
