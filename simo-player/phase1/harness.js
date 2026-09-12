#!/usr/bin/env node
/* Shared vm harness for the simo-player tests.
 *
 * Loads simo-player/data.js and the pure-logic head of simo-player/app.js
 * (everything above the `//__PURE_END__` marker — the JSX components and the
 * gated ReactDOM bootstrap live below it and are NOT executed here) into a
 * Node vm with stub React/ReactDOM/Leaflet. No window/document/localStorage
 * globals are provided on purpose: the pure head must be DOM-free (test 18).
 *
 * As a module:  const { loadApp } = require('./harness.js')
 * As a CLI (used by test_mock.py):
 *   node harness.js chips  '<json [[name,size],...]>'  -> classifyUploadFile
 *   node harness.js approve '<json draft>'             -> approveDraft summary
 *   node harness.js interp_edge                        -> frame-edge lengths
 *   node harness.js scale <lat> <zoom>                 -> {pxPerMetre}
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PURE_MARK = '//__PURE_END__';

function anyFn() {
  const f = function () {};
  return new Proxy(f, { get: () => anyFn(), apply: () => anyFn() });
}

function stubReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: 'Fragment',
    createContext: (d) => ({ Provider: 'Provider', Consumer: 'Consumer', _default: d }),
    useContext: () => null,
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useReducer: (r, v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (f) => f(),
    useCallback: (f) => f,
    useRef: (v) => ({ current: v === undefined ? null : v }),
  };
}

function loadApp() {
  const dataPath = path.join(ROOT, 'data.js');
  const appPath = path.join(ROOT, 'app.js');
  for (const p of [dataPath, appPath]) {
    if (!fs.existsSync(p)) throw new Error('missing file: ' + p);
  }
  const dataSrc = fs.readFileSync(dataPath, 'utf8');
  const appFull = fs.readFileSync(appPath, 'utf8');
  const mark = appFull.indexOf(PURE_MARK);
  if (mark < 0) throw new Error('app.js lacks the pure-region marker ' + PURE_MARK);
  const head = appFull.slice(0, mark);
  const sandbox = {
    console, JSON, Math, Date, atob, btoa,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 0,
    React: stubReact(),
    ReactDOM: { createRoot: () => ({ render: () => {} }) },
    L: anyFn(),
  };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext(head, sandbox, { filename: 'app.js (pure head)' });
  return sandbox;
}

function cmdChips(arg, ctx) {
  const pairs = JSON.parse(arg);
  if (typeof ctx.classifyUploadFile !== 'function') {
    throw new Error('app.js pure head does not define classifyUploadFile');
  }
  return pairs.map(([name, size]) => ctx.classifyUploadFile(name, size));
}

function cmdApprove(arg, ctx) {
  const draft = JSON.parse(arg);
  if (typeof ctx.approveDraft !== 'function') {
    throw new Error('app.js pure head does not define approveDraft');
  }
  const state = {
    view: 'discover',
    catalog: ctx.CATALOG,
    activeSimId: null,
    activeScenario: 'today',
    running: false,
    draftSub: draft,
  };
  const before = state.catalog.length;
  const next = ctx.approveDraft(state, draft);
  const last = next.catalog[next.catalog.length - 1];
  return {
    before,
    after: next.catalog.length,
    origUnmutated: state.catalog.length === before &&
      !state.catalog.includes(last),
    view: next.view,
    activeSimId: next.activeSimId,
    lastId: last && last.id,
    lastAuthor: last && last.author,
    lastTitle: last && last.title,
    lastAnchor: last && last.anchor,
    lastScenariosHaveLanes: !!(last && last.scenarios &&
      Object.values(last.scenarios).every(s => (s.lanes || []).length > 0)),
    draftCleared: next.draftSub === null || next.draftSub === undefined,
  };
}

/* Load streams/balagere-t-junction.js: parse the JSONP-style callback and
 * return the payload (nFrames, bounds, scenarios.{today,proposed}.frames). */
function loadBalagereStream() {
  const sp = path.join(ROOT, 'streams', 'balagere-t-junction.js');
  if (!fs.existsSync(sp)) throw new Error('missing stream file: ' + sp);
  const src = fs.readFileSync(sp, 'utf8');
  const m = src.match(/^window\.__simoStreamCallback\('[^']+',\s*(\{.*\})\);\s*$/s);
  if (!m) throw new Error('stream file is not a __simoStreamCallback payload');
  return JSON.parse(m[1]);
}

function cmdInterpEdge(ctx) {
  if (typeof ctx.TrafficSimEngine !== 'function') {
    throw new Error('app.js pure head does not define TrafficSimEngine');
  }
  const stream = loadBalagereStream();
  const eng = new ctx.TrafficSimEngine(stream);
  const nf = stream.nFrames;
  const len = (t) => {
    const v = eng.getVehiclesAtTime(t, 'today');
    if (!Array.isArray(v)) throw new Error('getVehiclesAtTime did not return an array at t=' + t);
    return v.length;
  };
  return { t0: len(0), tNF: len(nf - 1), tNFfrac: len(nf - 0.1), tOver: len(nf + 51), tNeg: len(-3) };
}

function cmdScale(lat, zoom, ctx) {
  if (typeof ctx.placementScale !== 'function') {
    throw new Error('app.js pure head does not define placementScale');
  }
  const s = ctx.placementScale(parseFloat(lat), parseFloat(zoom));
  if (typeof s !== 'number' || !isFinite(s)) {
    throw new Error('placementScale must return a finite number (px per metre)');
  }
  return { pxPerMetre: s };
}

if (require.main === module) {
  try {
    const [, , cmd, a0, a1] = process.argv;
    const ctx = loadApp();
    let out;
    if (cmd === 'chips') out = cmdChips(a0, ctx);
    else if (cmd === 'approve') out = cmdApprove(a0, ctx);
    else if (cmd === 'interp_edge') out = cmdInterpEdge(ctx);
    else if (cmd === 'scale') out = cmdScale(a0, a1, ctx);
    else throw new Error('unknown harness command: ' + cmd);
    process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stderr.write(String((e && e.stack) || e) + '\n');
    process.exit(2);
  }
}

module.exports = { loadApp, PURE_MARK, ROOT };
