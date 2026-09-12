/* Draft moderation: slug, submission metadata, approveDraft. Ported verbatim
 * from the app.js pure head. */
import { hashStr } from './util.js';
import { defaultZonePoly } from './geo.js';

export function slugTitle(title) {
  const s = String(title == null ? '' : title).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'sim';
}

/* Catalog id for a new entry: slug + base36 timestamp. Shared by the local
 * approveDraft publish and the server-submit flow (the POST body carries
 * this id; the persisted entry must match it). */
export function entryIdFor(title) {
  return slugTitle(title) + '-' + Date.now().toString(36);
}

/* Geometry for a submitted bundle. draft.geo is the slot shape
 * {today: parseNetXml result|null, proposed: ...|null}; draft.demandCount
 * is the real .rou.xml count. scenarios.today always publishes (placeholder
 * cross when the today net is missing); scenarios.proposed only when a
 * proposed net was uploaded. One demand serves both scenarios; peakServed
 * stays hash-synthetic. */
export function defaultSimMeta(draft) {
  const h = hashStr('meta:' + (draft && draft.title));
  const dc = draft ? draft.demandCount : undefined;
  const demand = typeof dc === 'number' && isFinite(dc) ? dc : 900 + (h % 4200);
  const peakServed = Math.round(demand * (0.25 + ((h >>> 7) % 50) / 100));
  const cross = [
    { p: [[-250, -16], [250, -16]], w: 3.2 },
    { p: [[250, 16], [-250, 16]], w: 3.2 },
    { p: [[-16, -250], [-16, 250]], w: 3.2 },
    { p: [[16, 250], [16, -250]], w: 3.2 },
  ];
  const slots = (draft && draft.geo) || {};
  const scen = (key, title) => {
    const g = slots[key];
    const hasReal = g && Array.isArray(g.lanes) && g.lanes.length > 0;
    return {
      title,
      sub: hasReal
        ? 'geometry preview · not a simulated run · '
          + g.lanes.length + ' lanes from .net.xml'
        : 'submitted bundle · placeholder geometry',
      lanes: hasReal ? g.lanes : cross,
      arms: hasReal ? (g.arms || {}) : {},
      phases: hasReal ? (g.phases || []) : [],
      stops: hasReal ? (g.stops || {}) : {},
      links: hasReal ? (g.links || {}) : {},
      /* geo-lock rides into the catalog entry so playback placement can
       * use simToLatLng instead of anchor+rotation */
      ...(hasReal && g.latlngMap
        ? { latlngMap: g.latlngMap, geoLocked: true } : {}),
      ...(hasReal && g.utm ? { utm: g.utm, geoLocked: true } : {}),
    };
  };
  return {
    demand,
    peakServed,
    nFrames: 900,
    zonePoly: null,               // approveDraft fills the ~40 m square
    scenarios: {
      today: scen('today', 'TODAY'),
      ...(slots.proposed ? { proposed: scen('proposed', 'PROPOSED') } : {}),
    },
  };
}

/* ---------------------------------------------------------- approveDraft
 * Pure moderation step ("assume true"): draft -> new catalog entry.
 * Never mutates state or draft. */
export function approveDraft(state, draft) {
  /* Geo-lock/placement comes from the TODAY net slot (a proposed net for a
   * modified junction overlaps the same area). */
  const today = (draft.geo && draft.geo.today) || null;
  const locked = !!(today && today.geoLocked);
  /* geo-locked nets anchor at the downloaded bounds centre and cannot be
   * rotated — the map bounds already fix position and orientation. */
  const anchor = draft.latlng || (locked ? today.anchor : null);
  /* Auto-snap data for geo-locked nets: the downloaded bbox becomes the
   * entry's bounds + zone rectangle (replacing the default 40 m square), so
   * open/publish can fitBounds the map straight onto the net. The export's
   * suggestedZoom, when present, caps the fit. */
  const o = (locked && today.latlngMap) ? today.latlngMap.orig : null;
  const snapBounds = o ? [[o[0], o[1]], [o[2], o[3]]] : null;
  const snapPoly = o
    ? [[o[0], o[1]], [o[0], o[3]], [o[2], o[3]], [o[2], o[1]]]
    : null;
  const newEntry = {
    id: entryIdFor(draft.title),
    title: draft.title,
    author: draft.username,
    anchor: anchor,
    rotation: locked ? 0 : (draft.rotation || 0),
    demand: draft.simMeta.demand,
    peakServed: draft.simMeta.peakServed,
    nFrames: draft.simMeta.nFrames,
    zonePoly: draft.simMeta.zonePoly || snapPoly || defaultZonePoly(anchor),
    addedAt: new Date().toISOString().slice(0, 10),
    desc: draft.desc || '',
    scenarios: draft.simMeta.scenarios,
  };
  if (snapBounds) {
    newEntry.bounds = snapBounds;
    if (today.suggestedZoom != null) {
      newEntry.suggestedZoom = today.suggestedZoom;
    }
  }
  const catalog = state.catalog.concat(newEntry);
  return {
    ...state,
    catalog,
    view: 'submissions',
    activeSimId: newEntry.id,
    draftSub: null,
    toast: 'published',
  };
}
