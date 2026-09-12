/* Submit wizard (6 steps, map-interactive anchor/rotation). Ported verbatim
 * from app.js. */
import React from 'react';
import L from 'leaflet';
import { MapProvider, MapOverlayProvider } from '../state/store.js';
import { classifyUploadFile, parseDemandCount, parseNetXml } from '../lib/netxml.js';
import { defaultSimMeta } from '../lib/draft.js';

const h = React.createElement;

export function SubmitFlow({ store }) {
  const map = React.useContext(MapProvider);
  const d = store.draftSub;
  const [step, setStep] = React.useState(0);
  const [reject, setReject] = React.useState('');
  const [over, setOver] = React.useState(false);
  /* steps 3/4 minimize the modal so the map is usable — but only after the
   * user explicitly asks via the preamble modal's CTA */
  const [minimized, setMinimized] = React.useState(false);

  /* step 3: click the map to drop the anchor pin. Registered at the map
   * container in the CAPTURE phase so it fires before any Leaflet layer
   * (zones, pins, markers) can stopPropagation on the click. Leaflet chrome
   * (zoom controls, attribution) sits inside the same container, so those
   * clicks must be excluded or they'd re-place the pin. */
  React.useEffect(() => {
    if (!map || step !== 3 || !minimized) return undefined;
    const h = (ev) => {
      if (ev.target.closest && ev.target.closest(
        '.anchor-bar, .leaflet-control, .leaflet-popup, .leaflet-tooltip')) {
        return;
      }
      const ll = map.mouseEventToLatLng(ev);
      store.placeDraft([+ll.lat.toFixed(5), +ll.lng.toFixed(5)]);
    };
    const el = map.getContainer();
    el.addEventListener('click', h, true);
    return () => { el.removeEventListener('click', h, true); };
  }, [map, step, minimized, store.placeDraft]);

  /* live geometry preview: paint parsed .net.xml lanes on the map overlay
   * during the anchor + rotation steps so the user sees the network rotate
   * and position in real geography. Draws the today net when present, else
   * the proposed net. Cleared on every other step/unmount. */
  const overlay = React.useContext(MapOverlayProvider);
  const lat = d.latlng && d.latlng[0], lng = d.latlng && d.latlng[1];
  /* Always have something to show: today net first, then proposed, then the
   * placeholder cross — so the rotation preview is never empty. */
  const previewNet = (d.geo && d.geo.today) || (d.geo && d.geo.proposed) || null;
  const previewGeo = previewNet
    || (defaultSimMeta(d).scenarios.today.lanes.length
      ? { lanes: defaultSimMeta(d).scenarios.today.lanes } : null);
  React.useEffect(() => {
    if (!overlay) return undefined;
    if ((step === 3 && d.latlng) || step === 4) {
      overlay.setDraft(previewGeo, d.latlng, d.rotation || 0);
    } else {
      overlay.clearDraft();
    }
    return () => { overlay.clearDraft(); };
  }, [overlay, step, minimized, lat, lng, d.rotation, previewGeo]);

  /* geo-locked nets take their orientation from the map bounds, so the
   * rotation is pinned to 0 when the rotation step is entered. */
  React.useEffect(() => {
    if (step === 4 && d.geo && d.geo.today && d.geo.today.geoLocked
        && (d.rotation || 0) !== 0) {
      store.updateDraft({ rotation: 0 });
    }
  }, [step, d.geo, d.rotation, store.updateDraft]);

  /* draggable marker at the chosen anchor (steps 3-5) */
  const latlngKey = d.latlng ? d.latlng.join(',') : '';
  React.useEffect(() => {
    if (!map || !d.latlng) return undefined;
    const mk = L.marker(d.latlng, { draggable: true });
    mk.on('dragend', () => {
      const ll = mk.getLatLng();
      store.placeDraft([+ll.lat.toFixed(5), +ll.lng.toFixed(5)]);
    });
    mk.addTo(map);
    return () => { map.removeLayer(mk); };
  }, [map, latlngKey, store.placeDraft]);

  /* Slot upload: DEMAND takes exactly one .rou.xml, TODAY/PROPOSED NET take
   * exactly one .net.xml each. Wrong extension -> slot-specific rejection.
   * Re-uploading a slot replaces it. The raw file text is kept on the slot
   * record (`text`) — the server-submit flow POSTs it for the real SUMO run. */
  const addSlot = (slot, list) => {
    const arr = Array.from(list || []);
    if (!arr.length) return;
    const f = arr[arr.length - 1];
    const c = classifyUploadFile(f.name, f.size);
    const want = slot === 'demand' ? 'routes' : 'network';
    const ext = slot === 'demand' ? '.rou.xml' : '.net.xml';
    if (!c || c.kind !== want) {
      setReject('DEMAND/TODAY NET/PROPOSED NET slot "' + slot.toUpperCase()
        + '": ' + f.name + ' — needs a ' + ext + ' file');
      return;
    }
    setReject('');
    if (typeof FileReader === 'undefined') {
      store.updateDraft({ files: { ...(d.files || {}), [slot]: c } });
      return;
    }
    const rd = new FileReader();
    rd.onload = () => {
      const text = String(rd.result || '');
      store.updateDraft({ files: { ...(d.files || {}), [slot]: { ...c, text } } });
      if (slot === 'demand') {
        /* real demand count parsed in-browser; 0 elements -> warn but keep */
        const n = parseDemandCount(text);
        store.updateDraft({ demandCount: n });
        if (n === 0) {
          setReject(f.name + ' — parsed 0 demand elements '
            + '(no <trip>/<vehicle>/<flow>); file kept, check your export');
        }
        return;
      }
      /* net slots: parse into draft.geo.<slot> for the live preview */
      const geo = parseNetXml(text);
      if (geo) {
        store.setDraftGeo(slot, geo);
        /* geo-locked today net: anchor pre-filled from the downloaded
         * bounds (placement comes from the TODAY net) */
        if (slot === 'today' && geo.geoLocked) store.placeDraft(geo.anchor);
      }
      else setReject(f.name + ' — parsed 0 lanes (not a SUMO net?)');
    };
    rd.readAsText(f);
  };

  const files = d.files || {};
  const canNext = [
    d.username.trim().length > 0,
    !!files.demand && !!files.today,
    d.title.trim().length > 0,
    !!d.latlng,
    true,
    false,
  ][step];

  let body = null;
  if (step === 0) {
    body = [
      h('h3', { key: 't' }, 'Pick a username'),
      h('div', { key: 'h', className: 'hint' },
        'Shown as the author. Google sign-in replaces this later — '
        + 'for now it is just a name.'),
      h('input', {
        key: 'i', type: 'text', placeholder: 'e.g. balagere-traffic',
        value: d.username, autoFocus: true,
        onChange: (ev) => store.updateDraft({ username: ev.target.value }),
      }),
    ];
  } else if (step === 1) {
    /* three individual slots: demand + today net required, proposed net
     * optional (skip = contribute without improving) */
    const slotDefs = [
      ['demand', 'DEMAND', '.rou.xml — trips/vehicles/flows, required, '
        + 'shared by both scenarios', 'route file'],
      ['today', 'TODAY NET', '.net.xml — required, sets the map placement',
        'network file'],
      ['proposed', 'PROPOSED NET',
        '.net.xml — optional, skip to contribute without improving',
        'network file'],
    ];
    const chip = (slot) => {
      const f = files[slot];
      return f
        ? h('span', { className: 'chip', key: 'c' + slot },
          h('b', null, slot.toUpperCase()),
          ' ' + f.name + ' · ' + (f.size / 1024).toFixed(1) + ' KB')
        : h('span', { className: 'chip', key: 'c' + slot },
          h('b', null, slot.toUpperCase()), ' — empty');
    };
    body = [
      h('h3', { key: 't' }, 'Upload the SUMO input set'),
      h('div', { key: 'h', className: 'hint' },
        'One demand (.rou.xml) plus the today net (.net.xml); a proposed '
        + 'net (.net.xml) is optional. Demand + net(s) is a complete SUMO '
        + 'input set — no .sumocfg needed.'),
      ...slotDefs.map(([slot, label, sub, accept]) => h('div', {
        key: slot, className: 'slot',
        onDragOver: (ev) => { ev.preventDefault(); setOver(slot); },
        onDragLeave: () => setOver(false),
        onDrop: (ev) => {
          ev.preventDefault();
          setOver(false);
          addSlot(slot, ev.dataTransfer.files);
        },
      }, [
        h('div', { key: 'l', className: 'slot-label' },
          h('b', null, label), h('span', { className: 'hint' }, sub)),
        h('input', {
          key: 'f', type: 'file', accept,
          onChange: (ev) => { addSlot(slot, ev.target.files); ev.target.value = ''; },
        }),
        over === slot ? h('div', { key: 'dz', className: 'dropzone over' },
          'drop ' + label.toLowerCase() + ' here') : null,
      ])),
      h('div', { key: 'c', className: 'chips' },
        slotDefs.map(([slot]) => chip(slot))),
      (files.demand || {}).name && typeof d.demandCount === 'number'
        ? h('div', { key: 'dc', className: 'hint' },
          'Parsed demand: ' + d.demandCount + ' vehicles (from '
          + files.demand.name + ')')
        : null,
      reject ? h('div', { key: 'r', className: 'reject' }, reject) : null,
    ];
  } else if (step === 2) {
    body = [
      h('h3', { key: 't' }, 'Name it'),
      h('input', {
        key: 'ti', type: 'text',
        placeholder: 'e.g. Kundalahalli peak U-turn ban', value: d.title,
        onChange: (ev) => store.updateDraft({ title: ev.target.value }),
      }),
      h('textarea', {
        key: 'ta', rows: 3, placeholder: 'What does this simulation show?',
        value: d.desc,
        onChange: (ev) => store.updateDraft({ desc: ev.target.value }),
      }),
    ];
  } else {
    body = [
      h('h3', { key: 't' }, 'Review'),
      h('div', { key: 'rv', className: 'review' }, [
        h('b', { key: 'a' }, 'AUTHOR'), h('span', { key: 'av' }, d.username),
        h('b', { key: 'f' }, 'DEMAND'),
        h('span', { key: 'fv' },
          files.demand ? files.demand.name + ' · ' + d.demandCount + ' veh' : '—'),
        h('b', { key: 'fn' }, 'TODAY NET'),
        h('span', { key: 'fnv' }, files.today ? files.today.name : '—'),
        h('b', { key: 'fp' }, 'PROPOSED NET'),
        h('span', { key: 'fpv' }, files.proposed ? files.proposed.name : '—'),
        h('b', { key: 't' }, 'TITLE'), h('span', { key: 'tv' }, d.title),
        h('b', { key: 'an' }, 'ANCHOR'),
        h('span', { key: 'anv', className: 'num' },
          d.latlng ? d.latlng.join(', ') : '—'),
        h('b', { key: 'r' }, 'ROTATION'),
        h('span', { key: 'rv2', className: 'num' }, (d.rotation || 0) + '°'),
      ]),
      h('div', { key: 'h', className: 'hint' },
        'Moderation is assumed in this mockup — submitting publishes '
        + 'straight onto the map.'),
    ];
  }

  /* Anchoring + rotation steps. Two presentations:
   * - preamble: the normal modal explains what to do, with a CTA that
   *   minimizes it (map placement is only armed while minimized);
   * - minimized: a bottom bar keeps the map fully interactive
   *   (pan / zoom / click-to-place / drag pin / rotate with live preview). */
  if ((step === 3 || step === 4) && minimized) {
    return h('div', { className: 'anchor-bar' },
      h('div', { className: 'ab-step' },
        'SUBMIT · STEP ' + (step + 1) + '/6'),
      h('div', { className: 'ab-body' },
        step === 3
          ? (d.latlng
            ? h('span', { className: 'num' },
              d.latlng[0].toFixed(5) + ', ' + d.latlng[1].toFixed(5))
            : 'Pan / zoom the map, then click to drop the anchor pin')
          : (d.geo && d.geo.today && d.geo.today.geoLocked
            ? h('span', null,
              'Rotation locked — the map bounds set the orientation.')
            : h('span', { className: 'fld', style: { padding: 0 } },
              h('label', null, 'ROT'),
              h('input', {
                type: 'range', min: -45, max: 45, step: 1,
                value: d.rotation || 0,
                onInput: (ev) => store.updateDraft(
                  { rotation: parseInt(ev.target.value, 10) || 0 }),
              }),
              h('span', { className: 'val' }, (d.rotation || 0) + '°')))),
      h('div', { className: 'ab-row' },
        h('button', { className: 'ghost', onClick: () => setMinimized(false) },
          'Show instructions'),
        h('button', { className: 'ghost', onClick: store.cancelDraft },
          'Cancel'),
        step === 3 && !d.latlng
          ? null
          : h('button', {
            onClick: () => { setMinimized(false); setStep(step + 1); },
          }, step === 3 ? 'Confirm anchor' : 'Confirm rotation')));
  }

  /* preamble bodies for the map-interactive steps (full modal) */
  if (step === 3) {
    body = [
      h('h3', { key: 't' }, 'Anchor it to the map'),
      h('div', { key: 'h', className: 'hint' },
        "The simulation's local origin sits at this point. Next you will "
        + 'pick the spot on the map: the window minimizes so you can pan '
        + 'and zoom freely, then click to drop the pin and drag it to '
        + 'fine-tune. Confirm when the pin sits on the junction.'),
      d.geo && d.geo.today && d.geo.today.geoLocked
        ? h('div', { key: 'gl', className: 'hint' },
          'Position locked to the downloaded map bounds — '
          + 'no manual anchoring needed')
        : null,
      d.latlng
        ? h('div', { key: 'll', className: 'hint num' },
          'current anchor: '
          + d.latlng[0].toFixed(5) + ', ' + d.latlng[1].toFixed(5))
        : null,
    ];
  } else if (step === 4) {
    body = [
      h('h3', { key: 't' }, 'Rotate the network'),
      h('div', { key: 'h', className: 'hint' },
        "Match the bundle's orientation to the real road — degrees clockwise "
        + 'from north-aligned. The window minimizes so you can watch the '
        + 'preview turn on the map while you drag the slider.'),
    ];
  }

  return h('div', {
    className: 'modal-veil',
    onClick: (ev) => { if (ev.target === ev.currentTarget) store.cancelDraft(); },
  },
    h('div', { className: 'modal' },
      h('div', { className: 'step' },
        'SUBMIT A SIMULATION · STEP ' + (step + 1) + '/6'),
      h('div', { key: step, className: 'flip-step' }, body),
      h('div', { className: 'row' },
        h('button', { className: 'ghost', onClick: store.cancelDraft }, 'Cancel'),
        step > 0
          ? h('button', {
            className: 'ghost',
            onClick: () => { setMinimized(false); setStep(step - 1); },
          }, 'Back') : null,
        step === 3 || step === 4
          ? h('button', { onClick: () => setMinimized(true) },
            step === 3 ? 'Minimize & select location' : 'Minimize & rotate')
          : step < 5
            ? h('button', {
              disabled: !canNext, onClick: () => setStep(step + 1),
            }, 'Next')
            : h('button', {
              disabled: store.submitting, onClick: store.submitDraft,
            }, store.submitting ? 'Simulating…' : 'Submit for review'))));
}
