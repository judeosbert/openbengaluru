/* Leaflet map + overlay wiring. Ported verbatim from app.js — note the
 * attach effect's dependency array `[entry, scenKey, map]` is load-bearing
 * (mergeStream swaps the entry OBJECT, not just the id) and locked by
 * test/html.test.js. */
import React from 'react';
import L from 'leaflet';
import { makeSimOverlay } from './overlay.js';
import { ZonesAndPins } from './ZonesAndPins.js';

const h = React.createElement;

export function TrafficMap({ store, onMap, onReady, onOverlay }) {
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
  }, [entry, scenKey, map]);

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
