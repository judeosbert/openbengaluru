/* App shell. Ported verbatim from app.js. */
import React from 'react';
import { useTrafficStore, MapProvider, MapOverlayProvider } from '../state/store.js';
import { TopBar } from './TopBar.js';
import { TrafficMap } from '../map/TrafficMap.js';
import { SimPanel } from './SimPanel.js';
import { SubmitFlow } from './SubmitFlow.js';
import { ExportFlow } from './ExportFlow.js';
import { loadSimStream } from '../map/overlay.js';

const h = React.createElement;

export function App() {
  const store = useTrafficStore();
  const [map, setMap] = React.useState(null);
  const [mapReady, setMapReady] = React.useState(false);
  const [overlayApi, setOverlayApi] = React.useState(null);
  const [exportOpen, setExportOpen] = React.useState(false);

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
      if (map && e) {
        if (e.bounds) {
          map.fitBounds(e.bounds, {
            padding: [48, 48], maxZoom: e.suggestedZoom || 18, animate: true,
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
        padding: [48, 48], maxZoom: entry.suggestedZoom || 18, animate: true,
      });
    }
  }, [store.activeSimId, map, store.draftSub]);

  /* toast auto-dismiss */
  React.useEffect(() => {
    if (!store.toast) return undefined;
    const id = setTimeout(store.dismissToast, 2600);
    return () => clearTimeout(id);
  }, [store.toast, store.dismissToast]);

  /* Lazy stream load: opening an entry whose scenarios lack frames pulls
   * streams/<id>.js via script injection and merges the payload into the
   * catalog (mergeStream). Synthetic entries never ship a stream file —
   * the onerror path is a no-op. */
  React.useEffect(() => {
    if (!entry) return;
    const needsFrames = Object.values(entry.scenarios || {})
      .some((s) => !s.frames);
    if (!needsFrames) return;
    loadSimStream(entry.id, (payload) => {
      if (payload) store.mergeStream(entry.id, payload);
    });
  }, [entry && entry.id]);

  const onScrub = (v) => { store.stopAll(); store.setSimT(v); };

  return h(React.Fragment, null,
    h(TopBar, {
      view: store.view, onView: store.setView,
      username: store.username, onUsername: store.setUsername,
      onNewSim: store.startDraft,
      onExport: () => setExportOpen(true),
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
              h('i', null), h('span', null, 'SIMO — BENGALURU TRAFFIC LAB')),
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
          exportOpen && map ? h(ExportFlow, {
            map, onClose: () => setExportOpen(false),
          }) : null,
          store.toast ? h('div', {
            className: 'toast', onClick: store.dismissToast,
          }, store.toast === 'published'
            ? 'Published — your simulation is live on the map.'
            : String(store.toast)) : null))));
}
