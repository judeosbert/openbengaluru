#!/usr/bin/env node
/* Layer B tests for the simo-player mockup (BalagereTrafficSpec plan).
 *
 * Runs with:  node test_app.js        (from inside simo-player/)
 *
 * Plain Node, no Jest, no transpile: regex target checks on app.js plus
 * vm-execution of its pure-logic head (above //__PURE_END__) via the shared
 * harness in phase1/harness.js.
 *
 * Tests 13-18 of the plan: TrafficSimEngine existence/behaviour and the
 * DOM-gated ReactDOM bootstrap.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let ROOT, PURE_MARK, loadApp;
try {
  ({ loadApp, PURE_MARK, ROOT } = require('./phase1/harness.js'));
} catch (e) {
  console.error('harness not loadable: ' + e.message);
  process.exit(1);
}

const APP = path.join(ROOT, 'app.js');
const NF = 900;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
    console.log('ok   - ' + name);
  } catch (e) {
    results.push(['FAIL', name, e]);
    console.log('FAIL - ' + name + '\n       ' + String(e.message || e).split('\n')[0]);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

let appSrc = null;
function src() {
  if (appSrc === null) {
    if (!fs.existsSync(APP)) throw new Error('app.js missing: ' + APP);
    appSrc = fs.readFileSync(APP, 'utf8');
  }
  return appSrc;
}

let ctxCache = null;
function ctx() {
  if (!ctxCache) ctxCache = loadApp();
  return ctxCache;
}

/* Decode the id set of one frame straight from the base64 stream blob:
   per frame u16 n, then n x 9-byte records <u16 id, i16 x, i16 y, u8 a/2,
   u8 speed*8, u8 type>. */
function frameIds(stream, scenKey, frameNo) {
  const buf = Buffer.from(stream.scenarios[scenKey].frames, 'base64');
  let o = 0;
  for (let f = 0; f < frameNo; f++) {
    const n = buf.readUInt16LE(o); o += 2 + 9 * n;
  }
  const n = buf.readUInt16LE(o); o += 2;
  const ids = new Set();
  for (let i = 0; i < n; i++) { ids.add(buf.readUInt16LE(o)); o += 9; }
  return ids;
}

// 13 -------------------------------------------------------------------------
test('test_engine_exists', () => {
  assert(/class\s+TrafficSimEngine/.test(src()),
    'app.js: no `class TrafficSimEngine` found');
  const c = ctx();
  assert(typeof c.TrafficSimEngine === 'function',
    'TrafficSimEngine not defined in pure head');
  const eng = new c.TrafficSimEngine(c.BALAGERE_STREAM);
  for (const m of ['getVehiclesAtTime', 'getStatsAt', 'clearCache']) {
    assert(typeof eng[m] === 'function', 'TrafficSimEngine missing method ' + m);
  }
});

// 14 -------------------------------------------------------------------------
test('test_engine_vehicle_sample', () => {
  const c = ctx();
  const eng = new c.TrafficSimEngine(c.BALAGERE_STREAM);
  for (const key of ['today', 'proposed']) {
    const v0 = eng.getVehiclesAtTime(0, key);
    assert(Array.isArray(v0), key + ': getVehiclesAtTime(0) not an array');
    const ids0 = frameIds(c.BALAGERE_STREAM, key, 0);
    assert(v0.length === ids0.size,
      key + ': frame 0 id mismatch (engine ' + v0.length + ' vs stream ' + ids0.size + ')');
    const v45 = eng.getVehiclesAtTime(45, key);
    const ids45 = frameIds(c.BALAGERE_STREAM, key, 45);
    assert(v45.length === ids45.size,
      key + ': frame 45 id mismatch (engine ' + v45.length + ' vs stream ' + ids45.size + ')');
    assert(v45.every(r => ids45.has(r[0])), key + ': frame 45 unknown ids returned');
    const vEnd = eng.getVehiclesAtTime(NF - 1, key);
    assert(vEnd.length > 0, key + ': frame NF-1 must be non-empty');
  }
});

// 15 -------------------------------------------------------------------------
test('test_engine_interpolation_exclusivity', () => {
  const c = ctx();
  const eng = new c.TrafficSimEngine(c.BALAGERE_STREAM);
  const at = (t) => new Map(eng.getVehiclesAtTime(t, 'today').map(r => [r[0], r]));
  const a = at(45), b = at(46), mid = at(45.5);
  let proven = 0;
  for (const [id, r0] of a) {
    const r1 = b.get(id);
    if (!r1) continue;
    const rm = mid.get(id);
    assert(rm, 'vehicle ' + id + ' missing at t=45.5 though present in both frames');
    for (const k of [1, 2, 3]) {                    // x, y, angle
      const lo = Math.min(r0[k], r1[k]), hi = Math.max(r0[k], r1[k]);
      if (lo === hi) continue;
      assert(rm[k] > lo && rm[k] < hi,
        'id ' + id + ' attr ' + k + ': ' + rm[k] + ' not strictly between ' +
        lo + ' and ' + hi);
      proven++;
    }
  }
  assert(proven > 0, 'no attribute provably interpolated at t=45.5');
});

// 16 -------------------------------------------------------------------------
test('test_engine_return_is_copy', () => {
  const c = ctx();
  const eng = new c.TrafficSimEngine(c.BALAGERE_STREAM);
  const first = eng.getVehiclesAtTime(120, 'today');
  assert(first.length > 0, 'frame 120 unexpectedly empty');
  const origX = first[0][1];
  first[0][1] = -99999;                              // mutate row
  first.push(['bogus']);                             // mutate array
  const second = eng.getVehiclesAtTime(120, 'today');
  assert(second.length === 0 || second[second.length - 1][0] !== 'bogus',
    'engine returned a shared array (push leaked across calls)');
  assert(second.length === eng.getVehiclesAtTime(120, 'today').length,
    'length changed after caller mutation');
  assert(second[0][1] === origX || second[0][0] !== first[0][0],
    'engine returned shared rows (in-place write leaked across calls)');
});

// 17 -------------------------------------------------------------------------
test('test_engine_stats_shape', () => {
  const c = ctx();
  const eng = new c.TrafficSimEngine(c.BALAGERE_STREAM);
  for (const key of ['today', 'proposed']) {
    for (const t of [0, 100, NF - 1]) {
      const s = eng.getStatsAt(t, key);
      assert(Array.isArray(s) && s.length === 5,
        key + '@' + t + ': stats must be [through,moving,stopped,queued,gridlock]');
      assert(s.every(v => Number.isInteger(v) && v >= 0),
        key + '@' + t + ': stats must be non-negative ints, got ' + JSON.stringify(s));
    }
  }
  eng.clearCache();
  const s = eng.getStatsAt(100, 'today');
  assert(s.length === 5, 'stats broken after clearCache()');
});

// 18 -------------------------------------------------------------------------
test('test_react_root_gated', () => {
  const s = src();
  assert(/typeof\s+document\s*!==?\s*['"]undefined['"]/.test(s),
    "app.js bootstrap must be gated on typeof document !== 'undefined'");
  assert(/ReactDOM\.createRoot\s*\(/.test(s),
    'app.js must bootstrap via ReactDOM.createRoot');
  assert(s.includes(PURE_MARK),
    'app.js must contain the pure-region marker ' + PURE_MARK);
  // loadApp() already ran the pure head in a vm with NO document/window
  // globals — reaching here proves the head is DOM-free.
  const c = ctx();
  assert(typeof c.TrafficSimEngine === 'function',
    'pure head failed to define TrafficSimEngine without DOM');
});

// 19 -------------------------------------------------------------------------
test('test_parse_net_xml', () => {
  const c = ctx();
  assert(typeof c.parseNetXml === 'function',
    'pure head must define parseNetXml');
  const xml = `<?xml version="1.0"?><net>
    <lane id="in_0" shape="0,0 100,0" width="3.2"/>
    <lane id="out_0" shape="100,0 200,50" width="3.0"/>
    <lane id=":j_0_0" shape="50,0 60,0"/>
    <tlLogic id="j" type="static" programID="0">
      <phase duration="42" state="GGrr"/><phase duration="4" state="yyrr"/>
    </tlLogic>
    <connection from="in" to="out" tl="j" linkIndex="0"/>
    <connection from="out" to="in" tl="j" linkIndex="2"/>
  </net>`;
  const g = c.parseNetXml(xml);
  assert(g && Array.isArray(g.lanes), 'parseNetXml must return lanes');
  assert(g.lanes.length === 2, 'internal :j lanes must be skipped, got ' + g.lanes.length);
  /* recentered: bounds centroid -> (0,0). dm (0,0)-(1000,0),(2000,500):
   * centre (1000,250) is removed -> first pt [-1000,-250], last [1000,250]. */
  assert(g.lanes[0].p[0][0] === -1000 && g.lanes[0].p[0][1] === -250,
    'recentered to bounds centroid: ' + JSON.stringify(g.lanes[0].p));
  assert(g.lanes[1].p[1][0] === 1000 && g.lanes[1].p[1][1] === 250,
    'relative offsets preserved through recenter');
  assert(g.lanes[0].w === 3.2, 'width preserved');
  assert(g.phases.length === 2 && g.phases[0][1] === 'GGrr', 'phases parsed');
  assert(Object.keys(g.links).length === 2, 'links parsed');
  assert(g.arms.West[0] === -1000 && g.arms.East[0] === 1000, 'arms recentered');
  assert(c.parseNetXml('<net><lane id=":x_0" shape="0,0 1,1"/></net>') === null,
    'net with only internal lanes -> null');
  assert(c.parseNetXml('not xml') === null, 'garbage -> null');
});

// 20 -------------------------------------------------------------------------
test('test_export_helpers', () => {
  const c = ctx();
  // osmApiUrl: bbox [minLat,minLng,maxLat,maxLng] -> OSM bbox=minLng,minLat,maxLng,maxLat
  const url = c.osmApiUrl([12.94, 77.71, 12.95, 77.72]);
  assert(/openstreetmap\.org\/api\/0\.6\/map\?bbox=/.test(url), 'osm url shape');
  assert(/bbox=77\.71,12\.94,77\.72,12\.95/.test(url),
    'lng/lat order: ' + url);
  // convertScript: runnable bash, netconvert auto-detect, geometry/tls flags
  const sh = c.convertScript([12.94, 77.71, 12.95, 77.72], 'test-area');
  assert(/^#!\/bin\/bash/.test(sh), 'shebang');
  assert(/SUMO_HOME\/bin\/netconvert|EclipseSUMO/.test(sh), 'netconvert detection');
  assert(/--osm-files/.test(sh), 'osm input flag');
  assert(/12\.94/.test(sh) && /77\.72/.test(sh), 'bbox embedded');
  assert(/test-area\.osm\.xml/.test(sh), 'safe area name');
  const shBad = c.convertScript([1, 2, 3, 4], 'a b; c$(d)');
  assert(/a-b-c-d-/.test(shBad) || !/[;$\`]/.test(shBad.split('\n')[4] || ''),
    'name sanitised');
});

// 21 -------------------------------------------------------------------------
test('test_geolock_parse', () => {
  const c = ctx();
  /* real netconvert net: <location> carries convBoundary (metres) and
   * origBoundary (minLng,minLat,maxLng,maxLat in WGS84 degrees). */
  const xml = `<?xml version="1.0"?><net>
    <location netOffset="-100,-200" convBoundary="0.00,0.00,657.05,606.79" origBoundary="77.714521,12.936900,77.721167,12.942532" projParameter="+proj=utm"/>
    <lane id="a_0" shape="0,0 10,20" width="3.2"/>
    <lane id="b_0" shape="600,600 657.05,606.79" width="3.0"/>
  </net>`;
  const g = c.parseNetXml(xml);
  assert(g && g.latlngMap, 'net with real origBoundary must expose latlngMap');
  assert(JSON.stringify(g.latlngMap.conv) === JSON.stringify([0, 0, 657.05, 606.79]),
    'convBoundary verbatim (metres): ' + JSON.stringify(g.latlngMap));
  assert(JSON.stringify(g.latlngMap.orig)
      === JSON.stringify([12.9369, 77.714521, 12.942532, 77.721167]),
    'orig converted to [minLat,minLng,maxLat,maxLng]: ' + JSON.stringify(g.latlngMap));
  assert(g.geoLocked === true, 'geoLocked flag must be set');
  const alat = (12.9369 + 12.942532) / 2, alng = (77.714521 + 77.721167) / 2;
  assert(Math.abs(g.anchor[0] - alat) < 1e-9 && Math.abs(g.anchor[1] - alng) < 1e-9,
    'anchor = orig bbox centre: ' + JSON.stringify(g.anchor));
  /* geo-locked lanes are NOT recentered: first lane keeps its original dm
   * coords (shape metres x10) — the lat/lng mapping needs them. */
  assert(g.lanes[0].p[0][0] === 0 && g.lanes[0].p[0][1] === 0
      && g.lanes[0].p[1][0] === 100 && g.lanes[0].p[1][1] === 200,
    'geo-locked lanes keep original dm coords: ' + JSON.stringify(g.lanes[0].p));
  /* hand-net sentinel origBoundary (-1e10) -> treated as absent; lanes STILL
   * recentered to the bounds centroid (back-compat with test 19). */
  const sentinel = `<?xml version="1.0"?><net>
    <location netOffset="0,0" convBoundary="0.00,0.00,200.00,50.00" origBoundary="-10000000000.00,-10000000000.00,-10000000000.00,-10000000000.00" projParameter="!"/>
    <lane id="in_0" shape="0,0 100,0" width="3.2"/>
    <lane id="out_0" shape="100,0 200,50" width="3.0"/>
  </net>`;
  const gs = c.parseNetXml(sentinel);
  assert(gs && gs.latlngMap === undefined && gs.geoLocked === undefined
      && gs.anchor === undefined,
    'sentinel origBoundary -> latlngMap/geoLocked/anchor absent');
  assert(gs.lanes[0].p[0][0] === -1000 && gs.lanes[0].p[0][1] === -250,
    'sentinel net lanes still recentered to centroid: '
    + JSON.stringify(gs.lanes[0].p));
});

// 22 -------------------------------------------------------------------------
test('test_geolock_mapping', () => {
  const c = ctx();
  assert(typeof c.simToLatLng === 'function',
    'pure head must export simToLatLng');
  const xml = `<?xml version="1.0"?><net>
    <location netOffset="-100,-200" convBoundary="0.00,0.00,657.05,606.79" origBoundary="77.714521,12.936900,77.721167,12.942532" projParameter="+proj=utm"/>
    <lane id="a_0" shape="0,0 10,20" width="3.2"/>
    <lane id="b_0" shape="600,600 657.05,606.79" width="3.0"/>
  </net>`;
  const g = c.parseNetXml(xml);
  const near = (p, lat, lng, label) => assert(
    p && Math.abs(p[0] - lat) < 1e-6 && Math.abs(p[1] - lng) < 1e-6,
    label + ': ' + JSON.stringify(p) + ' != [' + lat + ', ' + lng + ']');
  near(c.simToLatLng(g, 0, 0), 12.9369, 77.714521,
    'sim (0,0)dm maps to the SW corner');
  near(c.simToLatLng(g, 6570.5, 6067.9), 12.942532, 77.721167,
    'sim (657.05,606.79)m maps to the NE corner');
  near(c.simToLatLng(g, 6570.5 / 2, 6067.9 / 2), 12.939716, 77.717844,
    'conv centre maps to the orig bbox centre');
  /* no latlngMap (hand nets, placeholders) -> null: caller keeps the
   * anchor+rotation placement path. */
  assert(c.simToLatLng({ lanes: [] }, 0, 0) === null,
    'simToLatLng must return null without latlngMap');
  assert(c.simToLatLng(null, 0, 0) === null, 'simToLatLng(null) -> null');
});

// 23 -------------------------------------------------------------------------
test('test_geolock_snap', () => {
  const c = ctx();
  /* zoom channel: the export's simo:zoom comment is plain text in the file,
   * so parseNetXml lifts it into geo.suggestedZoom regardless of whether the
   * DOMParser or the regex fallback path runs. */
  const xmlZoom = `<?xml version="1.0"?>
<!-- simo:zoom=15 -->
<net>
    <location netOffset="-100,-200" convBoundary="0.00,0.00,657.05,606.79" origBoundary="77.714521,12.936900,77.721167,12.942532" projParameter="+proj=utm"/>
    <lane id="a_0" shape="0,0 10,20" width="3.2"/>
    <lane id="b_0" shape="600,600 657.05,606.79" width="3.0"/>
  </net>`;
  const gz = c.parseNetXml(xmlZoom);
  assert(gz && gz.geoLocked, 'zoom fixture must parse as geo-locked');
  assert(gz.suggestedZoom === 15,
    'simo:zoom=15 comment -> geo.suggestedZoom 15, got ' + (gz && gz.suggestedZoom));

  /* approveDraft: a geo-locked draft publishes with bounds + bbox zonePoly
   * (replacing the default 40 m square) so the map can auto-snap on open. */
  const geo = {
    lanes: [{ p: [[0, 0], [100, 200]], w: 3.2 }],
    arms: {}, phases: [], stops: {}, links: {},
    latlngMap: { conv: [0, 0, 657.05, 606.79], orig: [12.93, 77.71, 12.94, 77.72] },
    anchor: [12.935, 77.715],
    geoLocked: true,
    suggestedZoom: 15,
  };
  const simMeta = {
    demand: 1000, peakServed: 500, nFrames: 900, zonePoly: null,
    scenarios: { today: { title: 'TODAY', lanes: geo.lanes, phases: [] } },
  };
  const approve = (g) => {
    const draft = {
      username: 'snap.tester', title: 'Snap Area', desc: '',
      latlng: null, rotation: 0, geo: g, simMeta,
    };
    const next = c.approveDraft({ catalog: [] }, draft);
    return next.catalog[next.catalog.length - 1];
  };
  const e = approve(geo);
  assert(JSON.stringify(e.bounds) === JSON.stringify([[12.93, 77.71], [12.94, 77.72]]),
    'entry.bounds = orig bbox [[minLat,minLng],[maxLat,maxLng]]: ' + JSON.stringify(e.bounds));
  assert(JSON.stringify(e.zonePoly) === JSON.stringify(
    [[12.93, 77.71], [12.93, 77.72], [12.94, 77.72], [12.94, 77.71]]),
    'entry.zonePoly = bbox rectangle corners: ' + JSON.stringify(e.zonePoly));
  assert(e.suggestedZoom === 15,
    'entry.suggestedZoom rides along from the draft geo: ' + e.suggestedZoom);

  /* same geo WITHOUT the zoom comment: bounds + zonePoly still set, and the
   * suggestedZoom key is omitted entirely (fitBounds uses its default cap). */
  const geoNoZoom = { ...geo };
  delete geoNoZoom.suggestedZoom;
  const e2 = approve(geoNoZoom);
  assert(JSON.stringify(e2.bounds) === JSON.stringify([[12.93, 77.71], [12.94, 77.72]]),
    'bounds set without zoom too: ' + JSON.stringify(e2.bounds));
  assert(Array.isArray(e2.zonePoly) && e2.zonePoly.length === 4,
    'zonePoly rectangle set without zoom too');
  assert(!('suggestedZoom' in e2),
    'no zoom comment -> no suggestedZoom key, got ' + JSON.stringify(e2.suggestedZoom));
});

// 24 -------------------------------------------------------------------------
test('test_geolock_utm_exact', () => {
  const c = ctx();
  assert(typeof c.utmToLatLng === 'function',
    'pure head must export utmToLatLng');
  /* EXACT <location> line from area.net.xml (Balagere): SIGNED netOffset,
   * UTM zone 43N. sim coords are (utm + netOffset), so the exact inverse of
   * netconvert's transform is utmToLatLng(sim - netOffset) — not the
   * convBoundary->origBoundary bbox stretch. Ground truth: OSM nodes. */
  const xml = `<?xml version="1.0"?><net>
    <location netOffset="-794602.11,-1431388.13" convBoundary="0.00,0.00,663.59,925.02" origBoundary="77.714521,12.933828,77.721480,12.942221" projParameter="+proj=utm +zone=43 +ellps=WGS84 +datum=WGS84 +units=m +no_defs"/>
    <lane id="a_0" shape="453.86,644.07 460.00,650.00" width="3.2"/>
  </net>`;
  const g = c.parseNetXml(xml);
  assert(g && g.utm, 'net with +proj=utm +zone=43 must expose geo.utm');
  assert(g.utm.offX === -794602.11 && g.utm.offY === -1431388.13
      && g.utm.zone === 43 && g.utm.south === false,
    'utm = {signed netOffset, zone, south}: ' + JSON.stringify(g.utm));
  assert(g.latlngMap && g.geoLocked,
    'latlngMap/geoLocked still set alongside utm (bounds/snap reuse orig)');
  const near = (p, lat, lng, label) => assert(
    p && Math.abs(p[0] - lat) < 1e-5 && Math.abs(p[1] - lng) < 1e-5,
    label + ': ' + JSON.stringify(p) + ' != [' + lat + ', ' + lng + ']');
  /* OSM node ground truth (api/0.6/node/…): sim metres (x10 for dm) -> WGS84.
   * The old bbox stretch was off by -18..-27 m E and up to +359 m N here. */
  near(c.simToLatLng(g, 4538.6, 6440.7), 12.9396644, 77.7192996,
    'utm wins: sim (453.86,644.07)m');
  near(c.simToLatLng(g, 3509.0, 3536.3), 12.9370509, 77.7183230,
    'utm wins: sim (350.90,353.63)m');
  near(c.simToLatLng(g, 4786.2, 6748.9), 12.9399404, 77.7195306,
    'utm wins: sim (478.62,674.89)m');
  /* raw helper: sim (453.86,644.07) - netOffset = (795055.97,1432032.20) */
  near(c.utmToLatLng(795055.97, 1432032.20, 43, false),
    12.9396644, 77.7192996, 'utmToLatLng direct');
  /* a UTM-less net (no +zone) has no geo.utm and keeps the linear latlngMap
   * mapping — simToLatLng falls through to the bbox stretch unchanged. */
  const xmlLinear = `<?xml version="1.0"?><net>
    <location netOffset="-100,-200" convBoundary="0.00,0.00,657.05,606.79" origBoundary="77.714521,12.936900,77.721167,12.942532" projParameter="+proj=utm"/>
    <lane id="a_0" shape="0,0 10,20" width="3.2"/>
    <lane id="b_0" shape="600,600 657.05,606.79" width="3.0"/>
  </net>`;
  const gl = c.parseNetXml(xmlLinear);
  assert(gl && !gl.utm && gl.latlngMap,
    'projParameter without +zone=NN -> no geo.utm, latlngMap kept');
  near(c.simToLatLng(gl, 0, 0), 12.9369, 77.714521,
    'fallback: sim (0,0)dm still maps to the SW corner linearly');
  near(c.simToLatLng(gl, 6570.5, 6067.9), 12.942532, 77.721167,
    'fallback: sim (657.05,606.79)m still maps to the NE corner linearly');
});

const failed = results.filter(r => r[0] !== 'ok');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
