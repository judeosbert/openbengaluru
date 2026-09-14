/* Map pins for ACTIVE catalog entries (the review-flow entries stamped
 * apiStream by the boot merge of GET /api/catalog). The preloaded
 * base-bundle entries stay marker-free. Pins are added ASYNCHRONOUSLY in
 * batches on page load (one timer per chunk) so a large catalog never
 * blocks the first paint.
 *
 * Stacking: the network-roads canvas is appended to the MAP CONTAINER
 * (overlay.js: getContainer().appendChild) at z 640, and .leaflet-map-pane
 * is a transformed stacking context pinned at effective 0 in that
 * container — so no Leaflet pane (or tooltip) can ever render above the
 * roads. The pins are therefore a plain DOM layer in the container itself
 * at z 645 (above the canvas, below the Leaflet controls). Pins whose
 * anchors land within OVERLAP_R container px would stack invisibly, so
 * every layout pass spreads overlapping pins into a vertical list (the
 * pure spreadOverlaps helper) — each marker stays visible and individually
 * clickable, and clicking a pin plays that sim.
 * .sim-pin/.dot/.pip/.tag styles ride in the generated data.js CSS blob —
 * same class names as the old ZonesAndPins layer. */
import React from 'react';
import L from 'leaflet';
import { pinEntries, batches, spreadOverlaps } from '../lib/pins.js';
import { escapeHtml } from './overlay.js';

const BATCH_SIZE = 40;    // pins per timer tick
const BATCH_MS = 30;      // spacing between ticks
const LAYER_Z = 645;      // above .sim-canvas (640), below the controls
const OVERLAP_R = 16;     // container px — pins closer than this overlap
const SPREAD_PX = 20;     // vertical gap in a spread list (>= pin height)

export function ActivePins({ map, catalog, activeSimId, onViewSim }) {
  React.useEffect(() => {
    const layer = document.createElement('div');
    layer.className = 'active-pins-layer';
    layer.style.zIndex = String(LAYER_Z);
    map.getContainer().appendChild(layer);

    const pins = new Map();       // id -> { el, latlng }
    const entries = pinEntries(catalog);
    const timers = [];
    let cancelled = false;

    /* container points of every placed pin, overlapped pins spread into
     * vertical lists (pure helper — view-relative, recomputed each pass),
     * then repositioned. Leaflet Points are read as .x/.y — a Point has
     * no toArray method. */
    const layout = () => {
      const raw = new Map();
      pins.forEach((p, id) => {
        const cp = map.latLngToContainerPoint(L.latLng(p.latlng[0],
          p.latlng[1]));
        raw.set(id, [cp.x, cp.y]);
      });
      spreadOverlaps(raw, OVERLAP_R, SPREAD_PX).forEach(([x, y], id) => {
        const p = pins.get(id);
        if (p) {
          p.el.style.left = x + 'px';
          p.el.style.top = y + 'px';
        }
      });
    };

    /* pan: 'move' fires per frame while dragging; zoom: 'zoom' fires at
     * the animation start (pins jump to the target view and stay put —
     * the map scales underneath for ~250 ms before zoomend redraw) */
    const sync = () => {
      if (cancelled) return;
      layout();
    };

    batches(entries.length, BATCH_SIZE).forEach((idxs, k) => {
      timers.push(setTimeout(() => {
        if (cancelled) return;
        for (const i of idxs) {
          const e = entries[i];
          const hasBoth = !!(e.scenarios && e.scenarios.today
            && e.scenarios.proposed);
          const el = document.createElement('div');
          el.className = 'sim-pin ' + (hasBoth ? 'proposed' : 'today')
            + (e.id === activeSimId ? ' active' : '');
          el.innerHTML = '<div class="dot"><i class="pip"></i>'
            + '<span class="tag">' + escapeHtml(e.title) + '</span>'
            + '<span class="tip"><b>' + escapeHtml(e.title) + '</b> — '
            + escapeHtml(e.author || '') + '</span></div>';
          /* stopPropagation: the layer sits over the map — a pin click
           * must not fall through to map handlers (zoom controls and
           * attribution are separate DOM, so they are unaffected) */
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            onViewSim(e.id);
          });
          layer.appendChild(el);
          pins.set(e.id, { el, latlng: e.anchor });
        }
        layout();
      }, BATCH_MS * k));
    });

    map.on('move zoom zoomend resize viewreset', sync);
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      map.off('move zoom zoomend resize viewreset', sync);
      layer.remove();
    };
  }, [map, catalog, activeSimId, onViewSim]);

  return null;
}
