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
import { CaptureView } from './CaptureView.js';
import { TutorialsView } from './TutorialsView.js';
import { PrivacyView } from './PrivacyView.js';
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
   * Failure is honest, never synthetic: streamFailed(id) + a toast — the
   * entry stays open with its real lanes and zero vehicles, SimPanel shows
   * an error note, and reopening the entry re-fires this effect (deps
   * [entry && entry.id]). Preview entries arrive with frames already merged
   * in the same batched update, so this effect never fires for them. */
  React.useEffect(() => {
    if (!entry) return;
    const needsFrames = Object.values(entry.scenarios || {})
      .some((s) => !s.frames);
    if (!needsFrames) return undefined;
    const onFail = () => {
      store.streamFailed(entry.id);
      store.setToast('could not load simulation data for "'
        + (entry.title || entry.id)
        + '" — check your connection and reopen the sim');
    };
    if (entry.apiStream) {
      let live = true;
      fetchCatalogStream(entry.id)
        .then((payload) => {
          if (payload && live) store.mergeStream(entry.id, payload);
          else if (live) onFail();
        })
        .catch(() => { if (live) onFail(); });
      return () => { live = false; };
    }
    loadSimStream(entry.id, (payload) => {
      if (payload) store.mergeStream(entry.id, payload);
      else onFail();
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
            streamError: store.streamErrorId === entry.id,
            onScenario: store.setScenario, onRun: store.runOnMap,
            onStop: store.stopAll, onScrub, onSpeed: store.setSpeed,
            onClose: store.closeSim,
          }) : null,
          store.draftSub ? h(SubmitFlow, { store }) : null,
          store.signGate ? h(SignInGate, { store }) : null,
          store.view === 'dashboard' ? h(DashboardView, { store }) : null,
          store.view === 'admin' ? h(AdminView, { store }) : null,
          store.view === 'contribute' ? h(ContributeView, { store }) : null,
          store.view === 'capture' ? h(CaptureView, { store }) : null,
          store.view === 'tutorials' ? h(TutorialsView, { store }) : null,
          store.view === 'privacy' ? h(PrivacyView, { store }) : null,
          store.exportOpen && map ? h(ExportFlow, {
            map, onClose: store.closeExport,
          }) : null,
          store.toast ? h('div', {
            className: 'toast', onClick: store.dismissToast,
          }, store.toast === 'published'
            ? 'Published — your simulation is live on the map.'
            : String(store.toast)) : null))));
}
