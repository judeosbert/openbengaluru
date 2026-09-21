/* Store hook + context seams. Ported verbatim from the app.js pure head;
 * auth wiring added by the Firebase Google sign-in plan; review-flow wiring
 * (me, boot catalog merge, preview, resubmit, no-reload submit) added by
 * the review-flow plan. Nothing is ever published locally: submit failures
 * keep the wizard open with an inline submitError, stream failures flip
 * streamErrorId (lanes-only playback + SimPanel note until a retry). */
import React from 'react';
import { CATALOG } from '../data.js';
import { entryIdFor } from '../lib/draft.js';
import { buildSimulateRequest, serverAvailable } from '../lib/submit.js';
import { authorFromProfile } from '../lib/profile.js';
import { mergeApiEntries } from '../lib/catalogMerge.js';
import { ingestSlot } from '../lib/ingestSlot.js';
import { signInWithGoogle, signOutUser, listenAuth, currentToken } from '../auth/firebase.js';
import * as api from '../api.js';

/* Seam for a future Google Maps implementation (plan: design decisions). */
export const MapProvider = React.createContext(null);
/* Publishes the live canvas overlay so the submit wizard can drive the
 * draft-geometry preview (parseNetXml lanes) during anchor/rotation. */
export const MapOverlayProvider = React.createContext(null);

/* ------------------------------------------------------------ store hook */
export function useTrafficStore() {
  const { useState, useCallback, useEffect } = React;

  /* Direct-route boot: capture.html sets window.__SIMO_VIEW = 'capture'
   * before the module loads, so the deep link opens the capture page
   * immediately; index.html (and file://) never set the marker -> the
   * plain 'discover' start. */
  const [view, setView] = useState(() => (
    typeof window !== 'undefined' && window.__SIMO_VIEW === 'capture'
      ? 'capture' : 'discover'));
  const [catalog, setCatalog] = useState(() => CATALOG || []);
  const [activeSimId, setActiveSimId] = useState(null);
  const [activeScenario, setActiveScenario] = useState('today');
  const [running, setRunning] = useState(false);
  const [simT, setSimT] = useState(0);
  const [speed, setSpeed] = useState(30);
  const [draftSub, setDraftSub] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  /* Submit failures keep the wizard open with the draft intact: this
   * persistent inline error (review step) is cleared on the next submit
   * attempt and whenever a draft opens/closes. Never a local publish. */
  const [submitError, setSubmitError] = useState(null);
  /* Id of the entry whose stream failed to load — App passes
   * streamError={streamErrorId === entry.id} to SimPanel (error note, no
   * numbers) and the map draws the real lanes with zero vehicles until a
   * reopen re-fires the lazy loader. Cleared when the stream merges. */
  const [streamErrorId, setStreamErrorId] = useState(null);
  const [toast, setToast] = useState(null);
  /* Google profile (null when signed out): uid/displayName/email — the
   * author identity for new sims (the old free-text username is gone). */
  const [user, setUser] = useState(null);
  /* Role discovery from the player server: { author, email, uid, isAdmin }
   * — gates the dashboard buttons. null when signed out OR when the server
   * is unavailable / the call fails (admin UI never appears). */
  const [me, setMe] = useState(null);
  /* Sign-in gate (submit + export): an unauthenticated entry into either
   * flow opens the explanatory modal (SignInGate) instead of popping
   * Firebase directly — the modal's Google CTA (signInFromGate) starts the
   * flow. The state holds the INTENT ('submit' | 'export') so the gate
   * copy and the post-sign-in continuation match the entry point. */
  const [signGate, setSignGate] = useState(null);
  /* Export-area flow open state lives here (not App-local) so the gate's
   * Google CTA can open the flow after a successful sign-in. */
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => listenAuth(setUser), []);

  /* Role fetch on user change; failure -> me=null (honest degradation). */
  useEffect(() => {
    let live = true;
    if (!user) {
      setMe(null);
      return undefined;
    }
    api.fetchMe()
      .then((info) => { if (live) setMe(info); })
      .catch(() => { if (live) setMe(null); });
    return () => { live = false; };
  }, [user]);

  /* Boot: merge the server's active submissions over the base catalog
   * (replace-by-id, apiStream stamp). file:// keeps the base bundle only —
   * serverAvailable gates exactly like the submit path. Failure -> base
   * only (never an error UI at boot). */
  useEffect(() => {
    const loc = typeof location !== 'undefined' ? location : null;
    if (!serverAvailable(loc)) return undefined;
    let live = true;
    api.fetchCatalog()
      .then((entries) => {
        if (!live || !Array.isArray(entries)) return;
        setCatalog((cat) => mergeApiEntries(cat, entries));
      })
      .catch(() => { /* base bundle stays */ });
    return () => { live = false; };
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
    /* real data landed for this id — clear its stream-failure flag */
    setStreamErrorId((cur) => (cur === id ? null : cur));
  }, []);

  /* Stream load failure (JSONP onerror / null payload, or the apiStream
   * fetch rejecting): App calls this + toasts — the entry stays open with
   * its real lanes and zero vehicles until a reopen retries. */
  const streamFailed = useCallback((id) => { setStreamErrorId(id); }, []);

  const setScenario = useCallback((key) => {
    setActiveScenario(key);
    setSimT(0);
    setRunning(false);      // plan failure-mode 6: toggle kills playback
  }, []);

  const closeSim = useCallback(() => {
    setRunning(false);
    setActiveSimId(null);
  }, []);

  /* Auth actions for the TopBar. Sign-in failure → honest toast, no
   * partial state. */
  const signIn = useCallback(() => {
    signInWithGoogle().catch((e) => {
      setToast('sign-in failed: ' + ((e && e.message) || e));
    });
  }, []);

  const signOut = useCallback(() => { signOutUser(); }, []);

  /* Fresh-submit wizard payload for a signed-in profile — shared by the
   * direct path (startDraft) and the sign-in-gate CTA (signInFromGate).
   * draft.username is derived from the verified profile, never typed. */
  const openDraftFor = useCallback((u) => {
    setDraftSub({
      username: authorFromProfile(u),
      /* three upload slots: demand (.rou.xml, required), today net
       * (.net.xml, required), proposed net (.net.xml, optional) */
      files: {}, geo: { today: null, proposed: null }, demandCount: null,
      latlng: null, rotation: 0,
      dataSource: '', sourceUrl: '',
      title: '', desc: '',
    });
  }, []);

  /* Flow gates (submit wizard + export area). Signed in: straight into the
   * flow. Signed out: the sign-in gate modal explains the requirement; its
   * Google CTA (signInFromGate) starts the Google flow and the flow only
   * appears after a successful sign-in. */
  const startDraft = useCallback(() => {
    setSubmitError(null);
    if (user) {
      openDraftFor(user);
      return;
    }
    setSignGate('submit');
  }, [user, openDraftFor]);

  const cancelDraft = useCallback(() => {
    setDraftSub(null);
    setSubmitError(null);
  }, []);

  /* The gate modal's Google CTA: run the sign-in flow, then continue into
   * the flow that opened the gate — export intent reopens the export area,
   * submit intent enters the wizard via the same opener startDraft uses.
   * Failure keeps the gate open (retryable) + honest toast. */
  const signInFromGate = useCallback(() => {
    const intent = signGate;
    signInWithGoogle().then((u) => {
      setSignGate(null);
      if (intent === 'export') setExportOpen(true);
      else openDraftFor(u);
    }).catch((e) => {
      setToast('sign-in failed: ' + ((e && e.message) || e));
    });
  }, [signGate, openDraftFor]);

  const closeSignGate = useCallback(() => { setSignGate(null); }, []);

  /* Export-area entry (same gate modal as submit): signed in opens the
   * flow directly; signed out opens the gate with the export intent. */
  const startExport = useCallback(() => {
    if (user) {
      setExportOpen(true);
      return;
    }
    setSignGate('export');
  }, [user]);

  const closeExport = useCallback(() => { setExportOpen(false); }, []);

  /* Parsed .net.xml geometry per slot ('today' | 'proposed') for the live
   * draft preview overlay. Re-uploading a slot replaces it. */
  const setDraftGeo = useCallback((slot, geo) => {
    setDraftSub((d) => (d && (slot === 'today' || slot === 'proposed')
      ? { ...d, geo: { ...d.geo, [slot]: geo } } : d));
  }, []);

  const updateDraft = useCallback((patch) => {
    setDraftSub((d) => (d ? { ...d, ...patch } : d));
  }, []);

  const placeDraft = useCallback((latlng) => {
    setDraftSub((d) => (d ? { ...d, latlng } : d));
  }, []);

  /* Submit = the REAL SUMO pipeline on the player server, always. Every
   * failure path (file:// origin, expired sign-in, server error, network
   * failure) keeps the wizard open with the draft intact and surfaces a
   * persistent inline error on the review step — Submit stays retryable.
   * NO path publishes anything to the catalog; entries only arrive through
   * GET /api/catalog after admin activation. Submissions NEVER go live
   * directly — the row lands `pending` for admin review, so success is NO
   * reload: a toast + the dashboard view. The id is the draft's pinned id
   * when resubmitting (same id, thread preserved), else the
   * entryIdFor(title) slug. The ID token rides along; the server derives
   * the author from the verified claims. */
  const submitDraft = useCallback(() => {
    if (!draftSub || submitting) return;
    setSubmitError(null);
    const loc = typeof location !== 'undefined' ? location : null;
    if (!serverAvailable(loc)) {
      setSubmitError('submitting runs the real SUMO simulation on the player'
        + ' server — open the player via `npm run dev` (http://localhost:5173)'
        + ' or `npm start`');
      return;
    }
    setSubmitting(true);
    currentToken().then((token) => {
      if (!token) {
        setSubmitError('your sign-in expired — sign in again and retry');
        return null;
      }
      return fetch('/api/simulate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(buildSimulateRequest(
          draftSub, draftSub.id || entryIdFor(draftSub.title))),
      }).then(async (res) => {
        if (res.ok) {
          setDraftSub(null);
          setToast('submitted — pending review');
          setView('dashboard');
          return;
        }
        const body = await res.json().catch(() => ({}));
        setSubmitError(body.error || 'HTTP ' + res.status);
      });
    }).catch((e) => {
      setSubmitError(String((e && e.message) || e));
    }).finally(() => setSubmitting(false));
  }, [draftSub, submitting]);

  const dismissToast = useCallback(() => { setToast(null); }, []);

  /* ---------------------------------------------------- review flow */

  /* previewSubmission: play a pending/rejected/inactive submission on the
   * map (owner or admin). Transient catalog entry — replace-by-id, stamped
   * entry.review = status so SimPanel shows the REVIEW chip — with frames
   * merged in the SAME batched update (React 18 batches promise
   * continuations, so the lazy-stream effect never fires a JSONP/404 for
   * preview entries). Gone on reload. */
  const previewSubmission = useCallback(async (id, status) => {
    try {
      const { entry, stream } = await api.fetchPreview(id);
      const stamped = { ...entry, review: status || 'pending' };
      setCatalog((cat) => mergeApiEntries(cat, [stamped]));
      if (stream) mergeStream(id, stream);
      viewSim(id);
      setView('discover');
    } catch (e) {
      setToast('preview failed: ' + ((e && e.message) || e));
    }
  }, [mergeStream, viewSim]);

  /* startResubmit: reopen the wizard prefilled from a stored submission —
   * title/desc/data source + the stored XMLs re-downloaded into the
   * draft slots (the id is PINNED: a successful re-pipeline replaces the
   * same row). Geo-locked today nets re-pin the anchor from the parsed
   * geometry, matching the wizard's upload path. */
  const startResubmit = useCallback(async (sub) => {
    if (!sub) return;
    const go = (u) => {
      setSubmitError(null);
      setDraftSub({
        username: authorFromProfile(u),
        files: {}, geo: { today: null, proposed: null }, demandCount: null,
        latlng: (typeof sub.anchor_lat === 'number'
          && typeof sub.anchor_lng === 'number')
          ? [sub.anchor_lat, sub.anchor_lng] : null,
        rotation: sub.rotation || 0,
        dataSource: sub.data_source || '',
        sourceUrl: sub.source_url || '',
        title: sub.title || '',
        desc: sub.description || '',
        id: sub.id,               // pinned id — resubmission reuses it
      });
    };
    if (user) {
      go(user);
    } else {
      try {
        go(await signInWithGoogle());
      } catch (e) {
        setToast('sign-in failed: ' + ((e && e.message) || e));
        return;
      }
    }
    try {
      const names = await api.fetchFileList(sub.id);
      for (const name of names) {
        const slot = name === 'demand.rou.xml' ? 'demand'
          : name === 'today.net.xml' ? 'today'
          : name === 'proposed.net.xml' ? 'proposed' : null;
        if (!slot) continue;
        const text = await api.fetchFileText(sub.id, name);
        const r = ingestSlot(slot, name, text);
        if (r.reject || !r.fileRecord) continue;
        setDraftSub((d) => (d ? {
          ...d,
          files: { ...d.files, [slot]: r.fileRecord },
          ...(slot === 'demand' ? { demandCount: r.demandCount } : {}),
          ...(slot !== 'demand' && r.geo
            ? { geo: { ...d.geo, [slot]: r.geo } } : {}),
        } : d));
        if (slot === 'today' && r.geo && r.geo.geoLocked) {
          placeDraft(r.geo.anchor);
        }
      }
    } catch (e) {
      setToast('could not load the stored sources: '
        + ((e && e.message) || e));
    }
  }, [user]);

  /* Local activate success: the transient preview entry is now legitimately
   * active in this session — drop the REVIEW chip. */
  const activateSim = useCallback(async (id, supersedes) => {
    const r = await api.activate(id, supersedes);
    setCatalog((cat) => cat.map((e) => (e.id === id && e.review != null
      ? Object.fromEntries(Object.entries(e).filter(
        ([k]) => k !== 'review'))
      : e)));
    return r;
  }, []);

  /* Local deactivate: the entry leaves the public catalog immediately —
   * drop the local copy too (other viewers keep theirs until reload). */
  const deactivateSim = useCallback(async (id) => {
    const r = await api.deactivate(id);
    setCatalog((cat) => {
      const next = cat.filter((e) => e.id !== id);
      if (next.length !== cat.length) {
        setActiveSimId((cur) => (cur === id ? null : cur));
      }
      return next;
    });
    return r;
  }, []);

  const rejectSim = useCallback(
    (id, comment) => api.reject(id, comment), []);
  const postComment = useCallback(
    (id, body) => api.postComment(id, body), []);

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
    draftSub, submitting, submitError,
    toast, setToast, streamErrorId, streamFailed, user, me,
    signGate, closeSignGate, signInFromGate,
    exportOpen, startExport, closeExport,
    setView, signIn, signOut, viewSim, runOnMap, stopAll, setScenario,
    closeSim, startDraft, cancelDraft, updateDraft, placeDraft, submitDraft,
    setDraftGeo, dismissToast, setSimT, setSpeed, tick, mergeStream,
    previewSubmission, startResubmit, activateSim, deactivateSim,
    rejectSim, postComment,
  };
}
