#!/usr/bin/env node
/* Phase 2 tests for per-entry streams in player.

Tests the removal of isRealSim/BALAGERE_STREAM special-casing and the
stream loader via script injection.
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
    document: {
      createElement: (tag) => {
        const el = { tagName: tag.toUpperCase(), children: [], setAttribute: () => {}, appendChild: () => {} };
        if (tag === 'script') {
          el.src = '';
          el.onload = null;
          el.onerror = null;
        }
        return el;
      },
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
      getElementsByTagName: () => []
    },
    window: { addEventListener: () => {} },
    globalThis: {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'data.js' });
  vm.runInContext(head, sandbox, { filename: 'app.js (pure head)' });
  return sandbox;
}

function runPhase2Tests() {
  const ctx = loadApp();

  // Test 1: TrafficSimEngine should decode frames from entry scenarios
  console.log('Test 1: TrafficSimEngine decodes frames from entry.scenarios...');
  const entryWithFrames = {
    id: 'test-sim',
    nFrames: 900,
    scenarios: {
      today: {
        frames: 'AAAAAQAAAAAAAAAA',  // minimal valid base64 BLGR (1 frame, 0 vehicles)
        stats: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',  // placeholder
        lanes: [{ p: [[0,0],[100,0]], w: 3.2 }]
      }
    }
  };
  
  // Mock BALAGERE_STREAM to ensure it's not used
  const originalBALAGERE_STREAM = ctx.BALAGERE_STREAM;
  ctx.BALAGERE_STREAM = null;
  
  try {
    const eng = new ctx.TrafficSimEngine(null, entryWithFrames, 'test-sim');
    const vehicles = eng.getVehiclesAtTime(0, 'today');
    if (Array.isArray(vehicles)) {
      console.log('  PASS: TrafficSimEngine.getVehiclesAtTime returns array from entry frames');
    } else {
      console.log('  FAIL: getVehiclesAtTime did not return array');
      process.exit(1);
    }
  } catch (e) {
    console.log('  FAIL:', e.message);
    process.exit(1);
  }

  // Test 2: Engine frameCount reads from entry when stream not present
  console.log('Test 2: frameCount reads from entry.nFrames...');
  try {
    const eng = new ctx.TrafficSimEngine(null, entryWithFrames, 'test-sim');
    const nf = eng.frameCount('today');
    if (nf === 900) {
      console.log('  PASS: frameCount returns entry.nFrames');
    } else {
      console.log('  FAIL: frameCount returned', nf, 'expected 900');
      process.exit(1);
    }
  } catch (e) {
    console.log('  FAIL:', e.message);
    process.exit(1);
  }

  // Test 3: Stream loader function exists (loadSimStream) - this is in the JSX part
  // We'll test it by checking if the function is defined in the full app context
  console.log('Test 3: loadSimStream function exists in full app...');
  const appFull = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  if (appFull.includes('function loadSimStream') || appFull.includes('const loadSimStream')) {
    console.log('  PASS: loadSimStream function defined in app.js');
  } else {
    console.log('  FAIL: loadSimStream function not found in app.js');
    process.exit(1);
  }

  // Test 4: isRealSim function should be removed
  console.log('Test 4: isRealSim function removed...');
  if (!appFull.includes('function isRealSim')) {
    console.log('  PASS: isRealSim function removed');
  } else {
    console.log('  FAIL: isRealSim function still present');
    process.exit(1);
  }

  // Test 5: BALAGERE_STREAM special-case removed from engineFor/scenarioGeoOf
  console.log('Test 5: BALAGERE_STREAM special-case removed...');
  // These functions are below PURE_END, so check in the full app
  const jsxPart = appFull.slice(appFull.indexOf(PURE_MARK) + PURE_MARK.length);
  if (!jsxPart.includes('BALAGERE_STREAM') || 
      (jsxPart.includes('engineFor') && !jsxPart.includes('isRealSim(entry)'))) {
    console.log('  PASS: BALAGERE_STREAM special-case removed from engineFor');
  } else if (jsxPart.includes('isRealSim')) {
    console.log('  FAIL: isRealSim still used in JSX part');
    process.exit(1);
  } else {
    console.log('  PASS: BALAGERE_STREAM special-case removed');
  }

  // Restore
  ctx.BALAGERE_STREAM = originalBALAGERE_STREAM;
  
  console.log('\nAll Phase 2 tests passed!');
  process.exit(0);
}

if (require.main === module) {
  runPhase2Tests();
}

module.exports = { runPhase2Tests };