/* App shell. Ported verbatim from app.js; review-flow additions: the lazy
 * stream loader branches on entry.apiStream (API-catalog entries fetch
 * /api/catalog/:id/stream; base entries keep the JSONP streams/<id>.js),
 * and the dashboard views render over the map. The TopBar Export entry
 * routes through the store sign-in gate (same popup as submit). */
import React from 'react';
import { useTrafficStore, MapProvider, MapOverlayProvider } from '../state/store.js';
import { TopBar } from './TopBar.js';
import { TrafficMap } from '../map/TrafficMap.js';
import { SimPanel } from './SimPanel.js';
import { SubmitFlow } from './SubmitFlow.js';
import { SignInGate } from './SignInGate.js';
import { ExportFlow } from './ExportFlow.js';
import { DashboardView } from './DashboardView.js';
import { AdminView } from './AdminView.js';
import { ContributeView } from './ContributeView.js';
import { TutorialsView } from './TutorialsView.js';
import { loadSimStream } from '../map/overlay.js';
import { fetchCatalogStream } from '../api.js';

const h = React.createElement;

/* fit padding: <=900px the bottom sheet covers up to 62% of the map —
 * fit the sim into the visible band above it instead of the full
 * viewport; desktop keeps the plain symmetric padding */
function fitPadding(m) {
  if (window.matchMedia('(max-width:900px)').matches) {
    return {
      paddingTopLeft: [24, 24],
      paddingBottomRight: [24, Math.round(m.getSize().y * 0.62)],
    };
  }
  return { padding: [48, 48] };
}

export function App() {
  const store = useTrafficStore();
  const [map, setMap] = React.useState(null);
  const [mapReady, setMapReady] = React.useState(false);
  const [overlayApi, setOverlayApi] = React.useState(null);

  const entry = store.catalog.find((e) => e.id === store.activeSimId) || null;
  const scenKey = entry && entry.scenarios[store.activeScenario]
    ? store.activeScenario : 'today';

  /* after a publish (catalog grew): snap to the new entry — fitBounds its
   * downloaded bbox when it has one (geo-locked), else fly to the anchor.
   * Panel opens via activeSimId (set by approveDraft through submitDraft). */
  const prevLen = React.useRef(store.catalog.length);
  React.useEffect(() => {
    if (store.catalog.length > prevLen.current) {
      const e = store.catalog[store.catalog.length - 1];
      /* boot merge (GET /api/catalog) grows the catalog too — that is not
       * a publish and must not snap the camera (the visible zoom/pan right
       * as the intro reveal exposes the map). Merged and preview entries
       * carry the apiStream stamp; a local publish never does. The
       * id-change effect already fits geo-locked previews. */
      if (map && e && !e.apiStream) {
        if (e.bounds) {
          map.fitBounds(e.bounds, {
            ...fitPadding(map), maxZoom: e.suggestedZoom || 18, animate: true,
          });
        } else {
          map.flyTo(e.anchor, 16, { duration: 0.9 });
        }
      }
    }
    prevLen.current = store.catalog.length;
  }, [store.catalog.length, map]);

  /* auto-snap on open: clicking a geo-locked pin later fits the map to the
   * entry's downloaded bounds too. Only on a real id change, and never while
   * the draft wizard is open (it owns the map during anchoring). */
  const prevSimId = React.useRef(store.activeSimId);
  React.useEffect(() => {
    const id = store.activeSimId;
    const changed = id !== prevSimId.current;
    prevSimId.current = id;
    if (!changed || !map || store.draftSub) return;
    if (entry && entry.bounds) {
      map.fitBounds(entry.bounds, {
        ...fitPadding(map), maxZoom: entry.suggestedZoom || 18, animate: true,
      });
    }
  }, [store.activeSimId, map, store.draftSub]);

  /* toast auto-dismiss */
  React.useEffect(() => {
    if (!store.toast) return undefined;
    const id = setTimeout(store.dismissToast, 2600);
    return () => clearTimeout(id);
  }, [store.toast, store.dismissToast]);

  /* Lazy stream load: opening an entry whose scenarios lack frames pulls the
   * frames and merges them into the catalog (mergeStream). Two sources:
   * - entry.apiStream -> GET /api/catalog/:id/stream (active submissions);
   * - else the base bundle's JSONP streams/<id>.js via script injection.
   * Synthetic entries never ship a stream file — the onerror path is a
   * no-op. Preview entries arrive with frames already merged in the same
   * batched update, so this effect never fires for them. */
  React.useEffect(() => {
    if (!entry) return;
    const needsFrames = Object.values(entry.scenarios || {})
      .some((s) => !s.frames);
    if (!needsFrames) return undefined;
    if (entry.apiStream) {
      let live = true;
      fetchCatalogStream(entry.id)
        .then((payload) => {
          if (payload && live) store.mergeStream(entry.id, payload);
        })
        .catch(() => { /* frames stay absent; stats still ride inline */ });
      return () => { live = false; };
    }
    loadSimStream(entry.id, (payload) => {
      if (payload) store.mergeStream(entry.id, payload);
    });
    return undefined;
  }, [entry && entry.id]);

  const onScrub = (v) => { store.stopAll(); store.setSimT(v); };

  return h(React.Fragment, null,
    h(TopBar, {
      view: store.view, onView: store.setView,
      user: store.user, me: store.me,
      onSignIn: store.signIn, onSignOut: store.signOut,
      onNewSim: store.startDraft,
      onExport: store.startExport,
    }),
    h(MapProvider.Provider, { value: map },
      h(MapOverlayProvider.Provider, { value: overlayApi },
        h('div', { className: 'map-wrap' },
          h(TrafficMap, {
            store, onMap: setMap, onReady: () => setMapReady(true),
            onOverlay: setOverlayApi,
          }),
          !mapReady ? h('div', { className: 'loader' },
            h('div', { className: 'mark' },
              h('i', null), h('span', null,
                'OpenBengaluru — What would you change?')),
            h('div', { className: 'spin' }),
            h('div', { className: 'msg' }, 'Loading map and simulations…'),
          ) : null,
          entry ? h(SimPanel, {
            entry, scenKey, simT: store.simT,
            running: store.running, speed: store.speed,
            onScenario: store.setScenario, onRun: store.runOnMap,
            onStop: store.stopAll, onScrub, onSpeed: store.setSpeed,
            onClose: store.closeSim,
          }) : null,
          store.draftSub ? h(SubmitFlow, { store }) : null,
          store.signGate ? h(SignInGate, { store }) : null,
          store.view === 'dashboard' ? h(DashboardView, { store }) : null,
          store.view === 'admin' ? h(AdminView, { store }) : null,
          store.view === 'contribute' ? h(ContributeView, { store }) : null,
          store.view === 'tutorials' ? h(TutorialsView, { store }) : null,
          store.exportOpen && map ? h(ExportFlow, {
            map, onClose: store.closeExport,
          }) : null,
          store.toast ? h('div', {
            className: 'toast', onClick: store.dismissToast,
          }, store.toast === 'published'
            ? 'Published — your simulation is live on the map.'
            : String(store.toast)) : null))));
}
