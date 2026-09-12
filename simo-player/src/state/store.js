/* Store hook + context seams. Ported verbatim from the app.js pure head. */
import React from 'react';
import { CATALOG } from '../data.js';
import { approveDraft, defaultSimMeta, entryIdFor } from '../lib/draft.js';
import { buildSimulateRequest, serverAvailable } from '../lib/submit.js';

/* Seam for a future Google Maps implementation (plan: design decisions). */
export const MapProvider = React.createContext(null);
/* Publishes the live canvas overlay so the submit wizard can drive the
 * draft-geometry preview (parseNetXml lanes) during anchor/rotation. */
export const MapOverlayProvider = React.createContext(null);

/* ------------------------------------------------------------ store hook */
export function useTrafficStore() {
  const { useState, useCallback } = React;

  const [view, setView] = useState('discover');
  const [catalog, setCatalog] = useState(() => CATALOG || []);
  const [activeSimId, setActiveSimId] = useState(null);
  const [activeScenario, setActiveScenario] = useState('today');
  const [running, setRunning] = useState(false);
  const [simT, setSimT] = useState(0);
  const [speed, setSpeed] = useState(30);
  const [draftSub, setDraftSub] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  const [username, setUsernameState] = useState(() => {
    if (typeof localStorage !== 'undefined') {
      try { return localStorage.getItem('simo.username') || ''; } catch (e) { /* ignore */ }
    }
    return '';
  });

  const setUsername = useCallback((name) => {
    setUsernameState(name);
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem('simo.username', name); } catch (e) { /* ignore */ }
    }
  }, []);

  const viewSim = useCallback((id) => {
    setActiveSimId(id);
    setRunning(false);
  }, []);

  const runOnMap = useCallback((id) => {
    if (id) setActiveSimId(id);
    setSimT(0);
    setRunning(true);
  }, []);

  const stopAll = useCallback(() => { setRunning(false); }, []);

  /* Merge a lazily-loaded stream payload (streams/<id>.js) into a catalog
   * entry: scenarios[key].frames (and nFrames) — stats already ride inline.
   * Immutable: new catalog array + new entry object. */
  const mergeStream = useCallback((id, payload) => {
    if (!payload || !payload.scenarios) return;
    setCatalog((cat) => cat.map((e) => {
      if (e.id !== id) return e;
      const scenarios = { ...e.scenarios };
      for (const k of Object.keys(payload.scenarios)) {
        scenarios[k] = { ...(scenarios[k] || {}), ...payload.scenarios[k] };
      }
      return {
        ...e,
        scenarios,
        nFrames: payload.nFrames || e.nFrames,
      };
    }));
  }, []);

  const setScenario = useCallback((key) => {
    setActiveScenario(key);
    setSimT(0);
    setRunning(false);      // plan failure-mode 6: toggle kills playback
  }, []);

  const closeSim = useCallback(() => {
    setRunning(false);
    setActiveSimId(null);
  }, []);

  const startDraft = useCallback(() => {
    setDraftSub({
      username,
      /* three upload slots: demand (.rou.xml, required), today net
       * (.net.xml, required), proposed net (.net.xml, optional) */
      files: {}, geo: { today: null, proposed: null }, demandCount: null,
      latlng: null, rotation: 0,
      title: '', desc: '', simMeta: null,
    });
  }, [username]);

  const cancelDraft = useCallback(() => { setDraftSub(null); }, []);

  /* Parsed .net.xml geometry per slot ('today' | 'proposed') for the live
   * draft preview overlay. Re-uploading a slot replaces it. */
  const setDraftGeo = useCallback((slot, geo) => {
    setDraftSub((d) => (d && (slot === 'today' || slot === 'proposed')
      ? { ...d, geo: { ...d.geo, [slot]: geo } } : d));
  }, []);

  const updateDraft = useCallback((patch) => {
    if (patch && typeof patch.username === 'string') setUsername(patch.username);
    setDraftSub((d) => (d ? { ...d, ...patch } : d));
  }, [setUsername]);

  const placeDraft = useCallback((latlng) => {
    setDraftSub((d) => (d ? { ...d, latlng } : d));
  }, []);

  /* Geometry-only publish: the local approveDraft moderation step. Used
   * directly on file:// and as the fallback when the server simulation
   * fails (the entry's sub label stays honest about being a preview). */
  const publishLocally = useCallback((draft) => {
    const next = approveDraft({ catalog }, draft);
    setCatalog(next.catalog);
    setView(next.view);
    setActiveSimId(next.activeSimId);
    setRunning(false);
    setSimT(0);
    setDraftSub(null);
    setToast(next.toast);
  }, [catalog]);

  const submitDraft = useCallback(() => {
    if (!draftSub || submitting) return;
    const draft = draftSub.simMeta
      ? draftSub
      : { ...draftSub, simMeta: defaultSimMeta(draftSub) };
    const loc = typeof location !== 'undefined' ? location : null;
    if (!serverAvailable(loc)) {
      publishLocally(draft);
      return;
    }
    /* server present: run the REAL SUMO pipeline, then reload into it —
     * data.js holds the persisted entry after the reload. On any failure
     * show the error and fall back to the geometry-only publish. */
    setSubmitting(true);
    fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSimulateRequest(draft, entryIdFor(draft.title))),
    }).then(async (res) => {
      if (res.ok) {
        location.reload();
        return;
      }
      const body = await res.json().catch(() => ({}));
      publishLocally(draft);
      setToast('server simulation failed — published preview only: '
        + (body.error || 'HTTP ' + res.status));
    }).catch((e) => {
      publishLocally(draft);
      setToast('server simulation failed — published preview only: ' + e);
    }).finally(() => setSubmitting(false));
  }, [draftSub, catalog, submitting, publishLocally]);

  const dismissToast = useCallback(() => { setToast(null); }, []);

  /* RAF tick: advance simT by speed x dt (frames are 1 Hz samples), stop at
   * the last frame. */
  const tick = useCallback((dt) => {
    setSimT((t) => {
      const entry = catalog.find((e) => e.id === activeSimId);
      const nf = entry ? entry.nFrames : 900;
      const nt = t + dt * speed;
      if (nt >= nf - 1) { setRunning(false); return nf - 1; }
      return nt;
    });
  }, [catalog, activeSimId, speed]);

  return {
    view, catalog, activeSimId, activeScenario, running, simT, speed,
    draftSub, submitting, toast, username,
    setView, setUsername, viewSim, runOnMap, stopAll, setScenario, closeSim,
    startDraft, cancelDraft, updateDraft, placeDraft, submitDraft, setDraftGeo,
    dismissToast, setSimT, setSpeed, tick, mergeStream,
  };
}
