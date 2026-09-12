/* Port of test_app.js tests 19, 21, 22, 23 (parse part), 24, 25, 26 —
 * parseNetXml (recentering, geo-lock, sentinel handling), simToLatLng /
 * utmToLatLng ground truth, upload classifier, demand counting.
 * Under the vitest node environment parseNetXml runs its regex fallback
 * path (no DOMParser) — same coverage as the old vm harness. */
import { describe, it, expect } from 'vitest';
import { parseNetXml, parseDemandCount, classifyUploadFile } from '../src/lib/netxml.js';
import { simToLatLng, utmToLatLng } from '../src/lib/geo.js';

// test_app.js 19 --------------------------------------------------------------
it('parse net xml', () => {
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
  const g = parseNetXml(xml);
  expect(g && Array.isArray(g.lanes), 'parseNetXml must return lanes').toBe(true);
  expect(g.lanes.length, `internal :j lanes must be skipped, got ${g.lanes.length}`).toBe(2);
  /* recentered: bounds centroid -> (0,0). dm (0,0)-(1000,0),(2000,500):
   * centre (1000,250) is removed -> first pt [-1000,-250], last [1000,250]. */
  expect(g.lanes[0].p[0][0] === -1000 && g.lanes[0].p[0][1] === -250,
    'recentered to bounds centroid: ' + JSON.stringify(g.lanes[0].p)).toBe(true);
  expect(g.lanes[1].p[1][0] === 1000 && g.lanes[1].p[1][1] === 250,
    'relative offsets preserved through recenter').toBe(true);
  expect(g.lanes[0].w, 'width preserved').toBe(3.2);
  expect(g.phases.length === 2 && g.phases[0][1] === 'GGrr', 'phases parsed').toBe(true);
  expect(Object.keys(g.links).length, 'links parsed').toBe(2);
  expect(g.arms.West[0] === -1000 && g.arms.East[0] === 1000, 'arms recentered').toBe(true);
  expect(parseNetXml('<net><lane id=":x_0" shape="0,0 1,1"/></net>'),
    'net with only internal lanes -> null').toBeNull();
  expect(parseNetXml('not xml'), 'garbage -> null').toBeNull();
});

// test_app.js 21 --------------------------------------------------------------
it('geolock parse', () => {
  /* real netconvert net: <location> carries convBoundary (metres) and
   * origBoundary (minLng,minLat,maxLng,maxLat in WGS84 degrees). */
  const xml = `<?xml version="1.0"?><net>
    <location netOffset="-100,-200" convBoundary="0.00,0.00,657.05,606.79" origBoundary="77.714521,12.936900,77.721167,12.942532" projParameter="+proj=utm"/>
    <lane id="a_0" shape="0,0 10,20" width="3.2"/>
    <lane id="b_0" shape="600,600 657.05,606.79" width="3.0"/>
  </net>`;
  const g = parseNetXml(xml);
  expect(!!(g && g.latlngMap),
    'net with real origBoundary must expose latlngMap').toBe(true);
  expect(JSON.stringify(g.latlngMap.conv),
    'convBoundary verbatim (metres): ' + JSON.stringify(g.latlngMap))
    .toBe(JSON.stringify([0, 0, 657.05, 606.79]));
  expect(JSON.stringify(g.latlngMap.orig),
    'orig converted to [minLat,minLng,maxLat,maxLng]: ' + JSON.stringify(g.latlngMap))
    .toBe(JSON.stringify([12.9369, 77.714521, 12.942532, 77.721167]));
  expect(g.geoLocked, 'geoLocked flag must be set').toBe(true);
  const alat = (12.9369 + 12.942532) / 2, alng = (77.714521 + 77.721167) / 2;
  expect(Math.abs(g.anchor[0] - alat) < 1e-9 && Math.abs(g.anchor[1] - alng) < 1e-9,
    'anchor = orig bbox centre: ' + JSON.stringify(g.anchor)).toBe(true);
  /* geo-locked lanes are NOT recentered: first lane keeps its original dm
   * coords (shape metres x10) — the lat/lng mapping needs them. */
  expect(g.lanes[0].p[0][0] === 0 && g.lanes[0].p[0][1] === 0
    && g.lanes[0].p[1][0] === 100 && g.lanes[0].p[1][1] === 200,
    'geo-locked lanes keep original dm coords: ' + JSON.stringify(g.lanes[0].p)).toBe(true);
  /* hand-net sentinel origBoundary (-1e10) -> treated as absent; lanes STILL
   * recentered to the bounds centroid (back-compat with parse net xml). */
  const sentinel = `<?xml version="1.0"?><net>
    <location netOffset="0,0" convBoundary="0.00,0.00,200.00,50.00" origBoundary="-10000000000.00,-10000000000.00,-10000000000.00,-10000000000.00" projParameter="!"/>
    <lane id="in_0" shape="0,0 100,0" width="3.2"/>
    <lane id="out_0" shape="100,0 200,50" width="3.0"/>
  </net>`;
  const gs = parseNetXml(sentinel);
  expect(gs && gs.latlngMap === undefined && gs.geoLocked === undefined
    && gs.anchor === undefined,
    'sentinel origBoundary -> latlngMap/geoLocked/anchor absent').toBe(true);
  expect(gs.lanes[0].p[0][0] === -1000 && gs.lanes[0].p[0][1] === -250,
    'sentinel net lanes still recentered to centroid: '
    + JSON.stringify(gs.lanes[0].p)).toBe(true);
});

// test_app.js 22 --------------------------------------------------------------
it('geolock mapping', () => {
  const xml = `<?xml version="1.0"?><net>
    <location netOffset="-100,-200" convBoundary="0.00,0.00,657.05,606.79" origBoundary="77.714521,12.936900,77.721167,12.942532" projParameter="+proj=utm"/>
    <lane id="a_0" shape="0,0 10,20" width="3.2"/>
    <lane id="b_0" shape="600,600 657.05,606.79" width="3.0"/>
  </net>`;
  const g = parseNetXml(xml);
  const near = (p, lat, lng, label) => expect(
    p && Math.abs(p[0] - lat) < 1e-6 && Math.abs(p[1] - lng) < 1e-6,
    `${label}: ${JSON.stringify(p)} != [${lat}, ${lng}]`).toBe(true);
  near(simToLatLng(g, 0, 0), 12.9369, 77.714521,
    'sim (0,0)dm maps to the SW corner');
  near(simToLatLng(g, 6570.5, 6067.9), 12.942532, 77.721167,
    'sim (657.05,606.79)m maps to the NE corner');
  near(simToLatLng(g, 6570.5 / 2, 6067.9 / 2), 12.939716, 77.717844,
    'conv centre maps to the orig bbox centre');
  /* no latlngMap (hand nets, placeholders) -> null: caller keeps the
   * anchor+rotation placement path. */
  expect(simToLatLng({ lanes: [] }, 0, 0),
    'simToLatLng must return null without latlngMap').toBeNull();
  expect(simToLatLng(null, 0, 0), 'simToLatLng(null) -> null').toBeNull();
});

// test_app.js 23 (parse part; approve part lives in draft.test.js) -------------
it('geolock parse lifts suggestedZoom from the simo:zoom comment', () => {
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
  const gz = parseNetXml(xmlZoom);
  expect(gz && gz.geoLocked, 'zoom fixture must parse as geo-locked').toBe(true);
  expect(gz.suggestedZoom,
    'simo:zoom=15 comment -> geo.suggestedZoom 15, got '
    + (gz && gz.suggestedZoom)).toBe(15);
});

// test_app.js 24 --------------------------------------------------------------
it('geolock utm exact', () => {
  /* EXACT <location> line from area.net.xml (Balagere): SIGNED netOffset,
   * UTM zone 43N. sim coords are (utm + netOffset), so the exact inverse of
   * netconvert's transform is utmToLatLng(sim - netOffset) — not the
   * convBoundary->origBoundary bbox stretch. Ground truth: OSM nodes. */
  const xml = `<?xml version="1.0"?><net>
    <location netOffset="-794602.11,-1431388.13" convBoundary="0.00,0.00,663.59,925.02" origBoundary="77.714521,12.933828,77.721480,12.942221" projParameter="+proj=utm +zone=43 +ellps=WGS84 +datum=WGS84 +units=m +no_defs"/>
    <lane id="a_0" shape="453.86,644.07 460.00,650.00" width="3.2"/>
  </net>`;
  const g = parseNetXml(xml);
  expect(!!(g && g.utm),
    'net with +proj=utm +zone=43 must expose geo.utm').toBe(true);
  expect(g.utm.offX === -794602.11 && g.utm.offY === -1431388.13
    && g.utm.zone === 43 && g.utm.south === false,
    'utm = {signed netOffset, zone, south}: ' + JSON.stringify(g.utm)).toBe(true);
  expect(g.latlngMap && g.geoLocked,
    'latlngMap/geoLocked still set alongside utm (bounds/snap reuse orig)').toBe(true);
  const near = (p, lat, lng, label) => expect(
    p && Math.abs(p[0] - lat) < 1e-5 && Math.abs(p[1] - lng) < 1e-5,
    `${label}: ${JSON.stringify(p)} != [${lat}, ${lng}]`).toBe(true);
  /* OSM node ground truth (api/0.6/node/…): sim metres (x10 for dm) -> WGS84.
   * The old bbox stretch was off by -18..-27 m E and up to +359 m N here. */
  near(simToLatLng(g, 4538.6, 6440.7), 12.9396644, 77.7192996,
    'utm wins: sim (453.86,644.07)m');
  near(simToLatLng(g, 3509.0, 3536.3), 12.9370509, 77.7183230,
    'utm wins: sim (350.90,353.63)m');
  near(simToLatLng(g, 4786.2, 6748.9), 12.9399404, 77.7195306,
    'utm wins: sim (478.62,674.89)m');
  /* raw helper: sim (453.86,644.07) - netOffset = (795055.97,1432032.20) */
  near(utmToLatLng(795055.97, 1432032.20, 43, false),
    12.9396644, 77.7192996, 'utmToLatLng direct');
  /* a UTM-less net (no +zone) has no geo.utm and keeps the linear latlngMap
   * mapping — simToLatLng falls through to the bbox stretch unchanged. */
  const xmlLinear = `<?xml version="1.0"?><net>
    <location netOffset="-100,-200" convBoundary="0.00,0.00,657.05,606.79" origBoundary="77.714521,12.936900,77.721167,12.942532" projParameter="+proj=utm"/>
    <lane id="a_0" shape="0,0 10,20" width="3.2"/>
    <lane id="b_0" shape="600,600 657.05,606.79" width="3.0"/>
  </net>`;
  const gl = parseNetXml(xmlLinear);
  expect(!!(gl && !gl.utm && gl.latlngMap),
    'projParameter without +zone=NN -> no geo.utm, latlngMap kept').toBe(true);
  near(simToLatLng(gl, 0, 0), 12.9369, 77.714521,
    'fallback: sim (0,0)dm still maps to the SW corner linearly');
  near(simToLatLng(gl, 6570.5, 6067.9), 12.942532, 77.721167,
    'fallback: sim (657.05,606.79)m still maps to the NE corner linearly');
});

// test_app.js 25 --------------------------------------------------------------
it('classify rejects sumocfg', () => {
  expect(classifyUploadFile('sim.sumocfg', 10),
    '.sumocfg must be rejected (null), got '
    + JSON.stringify(classifyUploadFile('sim.sumocfg', 10))).toBeNull();
  const r = classifyUploadFile('route.rou.xml', 12);
  expect(r && r.kind, '.rou.xml -> routes').toBe('routes');
  const n = classifyUploadFile('area.net.xml', 20);
  expect(n && n.kind, '.net.xml -> network').toBe('network');
  const u = classifyUploadFile('UPPER.ROU.XML', 5);
  expect(u && u.kind, 'case-insensitive .rou.xml -> routes').toBe('routes');
});

// test_app.js 26 --------------------------------------------------------------
it('parse demand count', () => {
  const xml = `<?xml version="1.0"?><routes>
    <trip id="t1" depart="0"/>
    <vehicle id="v1" depart="0"/>
    <flow id="f1" begin="0" end="3600" vehsPerHour="60"/>
    <flow id="f2" begin="0" end="3600" number="12"/>
    <flow id="f3" begin="0" end="3600"/>
  </routes>`;
  expect(parseDemandCount(xml),
    'trips/vehicles count 1, vehsPerHour/number contribute their value, '
    + `bare flow contributes 1, got ${parseDemandCount(xml)}`).toBe(1 + 1 + 60 + 12 + 1);
  expect(parseDemandCount('not xml at all'), 'garbage -> 0').toBe(0);
  expect(parseDemandCount('<net><lane id="a_0" shape="0,0 1,1"/></net>'),
    'net with no demand elements -> 0').toBe(0);
  expect(parseDemandCount(''), 'empty -> 0').toBe(0);
  expect(parseDemandCount(null), 'null -> 0').toBe(0);
  const caseXml = '<routes><trip id="a"/><flow id="b" VEHPERHOUR="30"/></routes>';
  expect(parseDemandCount(caseXml),
    'VEHPERHOUR (wrong case) is not the vehsPerHour= attribute: trip 1 + '
    + `flow without numeric vehsPerHour/number 1 = 2, got ${parseDemandCount(caseXml)}`)
    .toBe(2);
});
