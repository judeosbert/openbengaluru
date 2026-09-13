/* Export-area modal: draw a box on the map, the SERVER fetches the OSM
 * roads + runs netconvert and returns the finished .net.xml (POST
 * /api/export-net via the authed exportNet wrapper). Draw UX:
 *   modal (idle) -> 'Draw a box' arms draw mode (minimizes to the
 *   anchor-bar) -> click-drag on the map draws an arbitrary rect ->
 *   drawn (bar: Redraw / Use this box / Cancel; drag inside the box
 *   moves it). No resize handles — Redraw instead, unlimited. */
import React from 'react';
import L from 'leaflet';
import { exportNet } from '../api.js';

const h = React.createElement;

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export function downloadText(filename, text, mime) {
  downloadBlob(filename, new Blob([text], { type: mime || 'text/plain' }));
}

export function ExportFlow({ store, map, onClose }) {
  const [bbox, setBbox] = React.useState(() => {
    const b = map.getBounds();
    return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  });
  /* 'modal' (form) -> 'armed' (draw mode) -> 'drawn' (box on map) */
  const [mode, setMode] = React.useState('modal');
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState(() => (
    typeof location !== 'undefined' && location.protocol === 'file:'
      ? 'export needs the player server (`npm run dev` / `npm start`)'
      : ''));
  const name = React.useRef('area');
  const boxRef = React.useRef(null);

  /* armed + drawn share one map-gesture effect: mousedown starts a draw
   * (armed) or a box move (drawn, pointer inside the box); mousemove
   * updates the rect; window-level mouseup finishes and ALWAYS re-enables
   * dragging (a release outside the container can never leave it stuck).
   * Zoom stays locked while the anchor-bar is up so the box's geographic
   * extent is stable for the whole draw session. */
  React.useEffect(() => {
    if (mode === 'modal') return undefined;

    map.scrollWheelZoom.disable();
    map.doubleClickZoom.disable();
    if (map.touchZoom) map.touchZoom.disable();
    if (map.boxZoom) map.boxZoom.disable();

    const el = map.getContainer();
    const styleOpts = {
      /* token-styled via .export-bbox (EXTRA_CSS); dashArray is a
       * non-color presentation option and stays here */
      className: 'export-bbox', weight: 1.5, dashArray: '6 5',
      fillOpacity: 0.08,
    };
    let rect = null;
    let gesture = null;   // { kind: 'draw' | 'move', anchor, bounds }

    const insideBox = (ev) => {
      if (!rect) return false;
      const p = map.mouseEventToContainerPoint(ev);
      const b = rect.getBounds();
      const pNw = map.latLngToContainerPoint(b.getNorthWest());
      const pSe = map.latLngToContainerPoint(b.getSouthEast());
      return p.x >= pNw.x && p.x <= pSe.x && p.y >= pNw.y && p.y <= pSe.y;
    };
    const publish = (b) => setBbox([
      Math.min(b.getSouth(), b.getNorth()),
      Math.min(b.getWest(), b.getEast()),
      Math.max(b.getSouth(), b.getNorth()),
      Math.max(b.getWest(), b.getEast()),
    ]);

    const dn = (ev) => {
      if (gesture) return;
      if (mode === 'armed') {
        const ll = map.mouseEventToLatLng(ev);
        rect = L.rectangle(L.latLngBounds(ll, ll), styleOpts).addTo(map);
        boxRef.current = rect;
        gesture = { kind: 'draw', anchor: ll };
        ev.preventDefault();
        map.dragging.disable();
        el.style.cursor = 'crosshair';
      } else if (rect && insideBox(ev)) {
        gesture = {
          kind: 'move',
          anchor: map.mouseEventToLatLng(ev),
          bounds: rect.getBounds(),
        };
        ev.preventDefault();
        map.dragging.disable();
      }
    };
    const mv = (ev) => {
      if (!gesture) {
        el.style.cursor = (mode === 'drawn' && insideBox(ev)) ? 'move' : '';
        return;
      }
      const ll = map.mouseEventToLatLng(ev);
      if (gesture.kind === 'draw') {
        rect.setBounds(L.latLngBounds(gesture.anchor, ll));
      } else {
        /* translate the drawn box: same size, offset by the pointer delta */
        const dLat = ll.lat - gesture.anchor.lat;
        const dLng = ll.lng - gesture.anchor.lng;
        const b = gesture.bounds;
        rect.setBounds(L.latLngBounds(
          [b.getSouth() + dLat, b.getWest() + dLng],
          [b.getNorth() + dLat, b.getEast() + dLng],
        ));
      }
    };
    /* mouseup lives on window so a release outside the map container can
     * never leave map.dragging disabled */
    const up = () => {
      if (!gesture) return;
      const g = gesture;
      gesture = null;
      map.dragging.enable();
      el.style.cursor = '';
      publish(rect.getBounds());
      if (g.kind === 'draw') setMode('drawn');
    };
    const key = (ev) => {
      if (ev.key === 'Escape') onClose();
    };
    el.addEventListener('mousedown', dn, true);
    el.addEventListener('mousemove', mv, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('keydown', key, true);
    return () => {
      el.removeEventListener('mousedown', dn, true);
      el.removeEventListener('mousemove', mv, true);
      window.removeEventListener('mouseup', up, true);
      window.removeEventListener('keydown', key, true);
      map.dragging.enable();
      el.style.cursor = '';
      map.scrollWheelZoom.enable();
      map.doubleClickZoom.enable();
      if (map.touchZoom) map.touchZoom.enable();
      if (map.boxZoom) map.boxZoom.enable();
      if (rect) map.removeLayer(rect);
      boxRef.current = null;
    };
  }, [mode, map]);

  const fmtB = (b) => b.map((v) => (+v).toFixed(5)).join(', ');
  const useView = () => {
    const b = map.getBounds();
    setBbox([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
    setStatus('box = current view');
  };

  const doExport = async () => {
    setBusy(true);
    setStatus('fetching OSM + running netconvert…');
    const nm = name.current || 'area';
    try {
      const blob = await exportNet(bbox,
        { name: nm, zoom: map.getZoom() });
      downloadBlob(nm + '.net.xml', blob);
      setStatus('saved ' + nm + '.net.xml — upload it in the Submit wizard');
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg === 'not signed in' || /auth/i.test(msg)) {
        setStatus('sign in to export');
      } else if (typeof location !== 'undefined'
          && location.protocol === 'file:'
          || /fetch|network/i.test(msg)) {
        setStatus('export needs the player server (`npm run dev` / '
          + '`npm start`) — ' + msg);
      } else {
        setStatus(msg);   // server errors surface verbatim (422 tail, 503…)
      }
    } finally {
      setBusy(false);
    }
  };

  /* anchor-bar: draw mode (armed or drawn) */
  if (mode !== 'modal') {
    return h('div', { className: 'anchor-bar' },
      h('div', { className: 'ab-step' }, 'EXPORT AREA'),
      h('div', { className: 'ab-body' },
        h('span', { className: 'num' }, fmtB(bbox)),
        h('div', { className: 'hint', style: { margin: '4px 0 0' } },
          mode === 'armed'
            ? 'Click-drag on the map to draw the box.'
            : 'Drag inside the box to move it.')),
      h('div', { className: 'ab-row' },
        mode === 'drawn'
          ? h('button', { className: 'ghost',
            onClick: () => setMode('armed') }, 'Redraw')
          : null,
        mode === 'drawn'
          ? h('button', { className: 'ghost',
            onClick: () => setMode('modal') }, 'Use this box')
          : null,
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
        'The player server downloads the OpenStreetMap roads for your box '
        + 'and runs netconvert for you — you get a SUMO .net.xml ready to '
        + 'upload in the Submit wizard.'),
      h('input', {
        type: 'text', defaultValue: name.current, placeholder: 'area name',
        onChange: (ev) => { name.current = ev.target.value || 'area'; },
        style: { margin: '6px 0' },
      }),
      h('div', { className: 'fld', style: { padding: '6px 0' } },
        h('label', null, 'BOX'),
        h('span', { className: 'val num' }, fmtB(bbox))),
      h('div', { className: 'row', style: { justifyContent: 'flex-start' } },
        h('button', { className: 'ghost', onClick: useView },
          'Use current view'),
        h('button', { className: 'ghost',
          onClick: () => { setStatus(''); setMode('armed'); } },
          'Draw a box')),
      h('div', { className: 'row' },
        h('button', { className: 'ghost', onClick: onClose }, 'Cancel'),
        h('button', { onClick: doExport, disabled: busy },
          'Download .net.xml')),
      status ? h('div', { className: 'hint' }, status) : null));
}
