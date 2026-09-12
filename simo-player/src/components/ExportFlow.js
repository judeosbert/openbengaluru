/* Export-area modal (bbox -> OSM download + convert.sh). Ported verbatim
 * from app.js. */
import React from 'react';
import L from 'leaflet';
import { osmApiUrl, convertScript } from '../lib/areaExport.js';

const h = React.createElement;

export function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export function ExportFlow({ store, map, onClose }) {
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
