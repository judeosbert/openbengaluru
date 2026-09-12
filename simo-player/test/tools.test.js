/* Port of tools/test_packer.py — tests for the Node packer tools:
 *
 * - Geometry extraction from .net.xml   (tools/sumo_geom.js)
 * - SUMO discovery                      (tools/sumo_geom.js)
 * - SUMO flag contract                  (tools/pack_run.js SUMO_FLAGS)
 * - BLGR binary packing                 (tools/blgr_pack.js)
 * - BLGR pack round-trip decoded with the REAL src/lib/engine.js
 *   (cross-validation locks the 9-byte record / 5-u16 row layouts)
 * - .simo.json output format            (tools/pack_run.js buildPack)
 * - per-scenario spec parsing           (tools/pack_run.js parseScenarioSpecs)
 * - demand reading / type mapping       (tools/blgr_pack.js)
 * - dev_inject idempotency              (tools/dev_inject.js)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findSumo, geoLock, geom } from '../tools/sumo_geom.js';
import {
  TYPES, VCLASS_TO_IDX, readDemand, buildTypeMap, buildHeader, packFcd, packStats,
} from '../tools/blgr_pack.js';
import { SUMO_FLAGS, parseScenarioSpecs, buildPack } from '../tools/pack_run.js';
import { readCatalog, writeCatalog, slug, statsDerive, injectPack, parseArgs as parseInjectArgs }
  from '../tools/dev_inject.js';
import { TrafficSimEngine } from '../src/lib/engine.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const FIXDIR = path.join(PLAYER_ROOT, 'test', 'fixtures');
const PACK_RUN = path.join(PLAYER_ROOT, 'tools', 'pack_run.js');

function writeTemp(text, suffix) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-packer-'));
  const p = path.join(td, 'file' + suffix);
  fs.writeFileSync(p, text);
  return p;
}

/* TestGeometryExtraction ----------------------------------------------------- */

it('geom extracts lanes', () => {
  const result = geom(path.join(FIXDIR, 'sample.net.xml'));
  expect(result).toBeInstanceOf(Object);
  for (const k of ['lanes', 'arms', 'phases', 'stops', 'links']) {
    expect(result, `geom result missing ${k}`).toHaveProperty(k);
  }
});

it('geom handles lanes with shape', () => {
  const netXml = `<?xml version="1.0" encoding="UTF-8"?>
<net version="1.16">
    <lane id="edge_0" shape="100.0,200.0 150.0,250.0" width="3.5"/>
</net>`;
  const tmp = writeTemp(netXml, '.net.xml');
  const result = geom(tmp);
  expect(result.lanes.length).toBe(1);
  const lane = result.lanes[0];
  expect(lane.w).toBe(3.5);
  // Points converted to dm (x10)
  expect(lane.p).toEqual([[1000, 2000], [1500, 2500]]);
});

it('geom skips internal lanes', () => {
  const netXml = `<?xml version="1.0" encoding="UTF-8"?>
<net version="1.16">
    <lane id=":junction_0" shape="0,0 10,10" width="3.2"/>
    <lane id="edge_0" shape="100,200 150,250" width="3.2"/>
</net>`;
  const tmp = writeTemp(netXml, '.net.xml');
  const result = geom(tmp);
  expect(result.lanes.length).toBe(1);
  expect(result.lanes[0].p).toEqual([[1000, 2000], [1500, 2500]]);
});

it('geom extracts phases', () => {
  const netXml = `<?xml version="1.0" encoding="UTF-8"?>
<net version="1.16">
    <tlLogic id="J1" type="static" programID="0" offset="0">
        <phase duration="42" state="GGrr"/>
        <phase duration="4" state="yyrr"/>
    </tlLogic>
</net>`;
  const tmp = writeTemp(netXml, '.net.xml');
  const result = geom(tmp);
  expect(result.phases.length).toBe(2);
  expect(result.phases[0]).toEqual([42, 'GGrr']);
  expect(result.phases[1]).toEqual([4, 'yyrr']);
});

it('geom extracts links and stops', () => {
  const netXml = `<?xml version="1.0" encoding="UTF-8"?>
<net version="1.16">
    <lane id="arm_e_0" shape="0,0 100,0" width="3.2"/>
    <tlLogic id="J1" type="static" programID="0" offset="0">
        <phase duration="42" state="GGrr"/>
    </tlLogic>
    <connection from="arm_e" tl="J1" linkIndex="0"/>
    <connection from="arm_e" tl="J1" linkIndex="1"/>
</net>`;
  const tmp = writeTemp(netXml, '.net.xml');
  const result = geom(tmp);
  expect(result.links).toHaveProperty('arm_e');
  expect(result.links.arm_e).toEqual([0, 1]);
  expect(result.stops).toHaveProperty('arm_e');
  // Stop is at the end of the lane shape (dm)
  expect(result.stops.arm_e).toEqual([1000, 0]);
});

it('geom extracts arms from dead ends', () => {
  const netXml = `<?xml version="1.0" encoding="UTF-8"?>
<net version="1.16">
    <junction id="Panathur" type="dead_end" x="-1316" y="-1"/>
    <junction id="Varthur" type="dead_end" x="1150" y="7"/>
</net>`;
  const tmp = writeTemp(netXml, '.net.xml');
  const result = geom(tmp);
  expect(result.arms).toHaveProperty('Panathur');
  expect(result.arms).toHaveProperty('Varthur');
  expect(result.arms.Panathur).toEqual([-13160, -10]);
  expect(result.arms.Varthur).toEqual([11500, 70]);
});

/* TestSumoDiscovery ----------------------------------------------------------- */

it('find sumo returns path', () => {
  const result = findSumo();
  // Just verify it returns something usable or null (null is acceptable
  // when SUMO is not installed in the test env).
  if (result) {
    expect(fs.existsSync(result) || fs.statSync(result).isFile(), result).toBe(true);
  }
});

/* TestSumoExecution — flag contract -------------------------------------------
 * pack_run.py:34-38 SUMO_FLAGS, locked verbatim (seed 42, step-length 1). */

it('sumo flags match video capture', () => {
  expect(SUMO_FLAGS).toEqual([
    '--fcd-output', '{fcd}',
    '--fcd-output.geo', 'false',
    '--summary-output', '{summ}',
    '--seed', '42',
    '--step-length', '1',
    '--time-to-teleport', '300',
    '--max-depart-delay', '1800',
    '-e', '{end}',
    '--no-step-log', '--no-warnings',
  ]);
  expect(SUMO_FLAGS.includes('42'), 'seed 42 locked').toBe(true);
  expect(SUMO_FLAGS[SUMO_FLAGS.indexOf('--step-length') + 1], 'step-length 1 locked')
    .toBe('1');
});

/* TestBlgrPacking -------------------------------------------------------------- */

it('pack fcd single frame', () => {
  // frame: [id, x_dm, y_dm, angle_div2, speed_x8, type_idx]
  const frame = [[1, 1000, 2000, 90, 80, 0]];
  const result = packFcd([frame]);
  // u16 nVehicles + 9 bytes per vehicle
  const expected = Buffer.alloc(2 + 9);
  expected.writeUInt16LE(1, 0);
  expected.writeUInt16LE(1, 2);
  expected.writeInt16LE(1000, 4);
  expected.writeInt16LE(2000, 6);
  expected.writeUInt8(90, 8);
  expected.writeUInt8(80, 9);
  expected.writeUInt8(0, 10);
  expect(Buffer.compare(Buffer.from(result), expected)).toBe(0);
});

it('pack fcd multiple frames', () => {
  const frames = [
    [[1, 1000, 2000, 90, 80, 0]],
    [[1, 1010, 2000, 90, 80, 0], [2, 500, 500, 45, 40, 1]],
  ];
  const result = Buffer.from(packFcd(frames));
  const expected = Buffer.alloc(2 + 9 + 2 + 18);
  let o = 0;
  const put = (v) => { expected.writeUInt16LE(v, o); o += 2; };
  const putS = (v) => { expected.writeInt16LE(v, o); o += 2; };
  const putB = (v) => { expected.writeUInt8(v, o); o += 1; };
  // Frame 0: 1 vehicle
  put(1);
  put(1); putS(1000); putS(2000); putB(90); putB(80); putB(0);
  // Frame 1: 2 vehicles
  put(2);
  put(1); putS(1010); putS(2000); putB(90); putB(80); putB(0);
  put(2); putS(500); putS(500); putB(45); putB(40); putB(1);
  expect(Buffer.compare(result, expected)).toBe(0);
});

it('pack stats shape', () => {
  // Stats are 5 u16 per frame.
  const stats = [[100, 50, 10, 5, 0], [100, 50, 10, 5, 0], [100, 50, 10, 5, 0]];
  const result = Buffer.from(packStats(stats));
  expect(result.length).toBe(3 * 5 * 2);  // 3 frames * 5 values * 2 bytes
  const flat = [];
  for (let i = 0; i < result.length; i += 2) flat.push(result.readUInt16LE(i));
  expect(flat).toEqual([100, 50, 10, 5, 0, 100, 50, 10, 5, 0, 100, 50, 10, 5, 0]);
});

it('build header format', () => {
  // Header matches BLGR spec: magic, version, nScenarios, nFrames, bounds.
  // Layout: <4sBBHhhhh> = 4 + 1 + 1 + 2 + 2*4 = 16 bytes.
  const bounds = [-1000, -2000, 3000, 4000];
  const nScenarios = 2;
  const nFrames = 900;
  const b = Buffer.from(buildHeader(nScenarios, nFrames, bounds));
  expect(b.length).toBe(16);
  expect(b.toString('ascii', 0, 4)).toBe('BLGR');
  expect(b.readUInt8(4)).toBe(1);                    // version
  expect(b.readUInt8(5)).toBe(nScenarios);
  expect(b.readUInt16LE(6)).toBe(nFrames);
  expect([b.readInt16LE(8), b.readInt16LE(10), b.readInt16LE(12), b.readInt16LE(14)])
    .toEqual(bounds);
});

/* BLGR round-trip decoded with the REAL engine ----------------------------------
 * packFcd/packStats must emit exactly the layouts TrafficSimEngine decodes. */

it('blgr pack round-trips through TrafficSimEngine', () => {
  const frames = [
    [[1, 1000, 2000, 90, 80, 0], [2, -5000, 30000, 45, 20, 1]],
    [[1, 1050, 2000, 92, 80, 0]],
    [],
  ];
  const stats = [[0, 1, 0, 0, 0], [10, 2, 1, 3, 0], [20, 3, 0, 0, 0]];
  const stream = {
    nFrames: frames.length,
    scenarios: {
      today: {
        frames: Buffer.from(packFcd(frames)).toString('base64'),
        stats: Buffer.from(packStats(stats)).toString('base64'),
      },
    },
  };
  const eng = new TrafficSimEngine(stream);
  expect(eng.frameCount('today')).toBe(3);
  // engine rows: [id, xDm, yDm, angleDeg, speedMps, typeIdx]
  expect(eng.getVehiclesAtTime(0, 'today')).toEqual([
    [1, 1000, 2000, 180, 10, 0],
    [2, -5000, 30000, 90, 2.5, 1],
  ]);
  expect(eng.getVehiclesAtTime(1, 'today')).toEqual([[1, 1050, 2000, 184, 10, 0]]);
  expect(eng.getVehiclesAtTime(2, 'today')).toEqual([]);
  expect(eng.getStatsAt(0, 'today')).toEqual([0, 1, 0, 0, 0]);
  expect(eng.getStatsAt(2, 'today')).toEqual([20, 3, 0, 0, 0]);
  // i16 extremes round-trip: x=32767 dm, y=-32768 dm, angle_div2=179, speed_x8=255
  // (x/y are i16 dm like the python struct '<HhhBBB' packer)
  const big = [[3, 32767, -32768, 179, 255, 4]];
  const bigStream = {
    nFrames: 1,
    scenarios: { today: { frames: Buffer.from(packFcd([big])).toString('base64') } },
  };
  const eng2 = new TrafficSimEngine(bigStream);
  expect(eng2.getVehiclesAtTime(0, 'today'))
    .toEqual([[3, 32767, -32768, 358, 31.875, 4]]);
});

/* TestSimoJsonOutput ------------------------------------------------------------
 * .simo.json output format consumed by TrafficSimEngine. */

function scenarioData() {
  const geometry = { lanes: [{ p: [[0, 0], [100, 0]], w: 3.2 }],
    arms: {}, phases: [], stops: {}, links: {} };
  const geo = {
    latlngMap: { conv: [5.47, 0.0, 651.33, 706.4],
      orig: [12.933828, 77.714521, 12.942221, 77.72148] },
    utm: { offX: -794602.11, offY: -1431388.13, zone: 43, south: false },
  };
  const frames = [[[0, 100, 200, 90, 80, 0]]];      // 1 frame, 1 vehicle
  const stats = [[0, 1, 0, 0, 0]];
  return { geometry, geo, frames, stats };
}

function buildOnce(geo) {
  const { geometry, frames, stats } = scenarioData();
  return buildPack({ today: { frames, stats, geometry, geo } }, 1);
}

it('simo json structure', () => {
  const out = buildOnce(scenarioData().geo);
  for (const k of ['nFrames', 'bounds', 'scenarios', 'anchor']) {
    expect(out, `missing top-level ${k}`).toHaveProperty(k);
  }
});

it('scenarios have frames and stats', () => {
  const out = buildOnce(scenarioData().geo);
  const sc = out.scenarios.today;
  expect(typeof sc.frames).toBe('string');
  expect(typeof sc.stats).toBe('string');
  // frames decodes to 1 frame with 1 vehicle
  const raw = Buffer.from(sc.frames, 'base64');
  expect(raw.readUInt16LE(0)).toBe(1);
});

it('geometry embedded', () => {
  const out = buildOnce(scenarioData().geo);
  const sc = out.scenarios.today;
  for (const k of ['lanes', 'arms', 'phases', 'stops', 'links']) {
    expect(sc, `scenario missing ${k}`).toHaveProperty(k);
  }
  expect(sc.lanes).toEqual(scenarioData().geometry.lanes);
});

it('bounds in dm', () => {
  // Bounds are in decimetres (dm) like the stream expects.
  const out = buildOnce(scenarioData().geo);
  expect(out.bounds).toEqual([100, 200, 100, 200]);
});

it('nframes matches stream', () => {
  const out = buildOnce(scenarioData().geo);
  expect(out.nFrames).toBe(1);
});

it('geo lock in scenario', () => {
  // latlngMap/utm/geoLocked ride on the scenario (catalog shape).
  const { geo } = scenarioData();
  const out = buildOnce(geo);
  const sc = out.scenarios.today;
  expect(sc.latlngMap).toEqual(geo.latlngMap);
  expect(sc.utm).toEqual(geo.utm);
  expect(sc.geoLocked).toBe(true);
});

it('anchor from geo', () => {
  // Top-level anchor = centre of the geo-locked orig bbox.
  const out = buildOnce(scenarioData().geo);
  expect(out.anchor[0]).toBeCloseTo(12.9380245, 6);
  expect(out.anchor[1]).toBeCloseTo(77.7180005, 6);
});

it('no geo no anchor', () => {
  // Hand nets (no provenance): no anchor, no geo keys.
  const out = buildOnce(null);
  expect(out.anchor).toBeNull();
  const sc = out.scenarios.today;
  expect(sc).not.toHaveProperty('latlngMap');
  expect(sc).not.toHaveProperty('utm');
  expect(sc).not.toHaveProperty('geoLocked');
});

/* TestTypeMapping ----------------------------------------------------------------
 * blgr_pack.buildTypeMap: rou vType id/vClass -> render-class index. */

const ROU = `<?xml version="1.0" encoding="UTF-8"?>
<routes>
    <vType id="DEFAULT_VEHTYPE" vClass="truck"/>
    <vType id="auto" vClass="taxi"/>
    <vType id="bangloreCar" vClass="passenger"/>
    <vType id="motorcycle" vClass="motorcycle"/>
    <vType id="schoolbus" vClass="bus"/>
    <vType id="water-tanker" vClass="truck"/>
</routes>`;

it('type map exact ids', () => {
  // Known ids match by id first (auto -> 4 even though vClass=taxi).
  expect(TYPES[TYPES.indexOf('auto')]).toBe('auto');
  const tmap = buildTypeMap(writeTemp(ROU, '.rou.xml'));
  expect(tmap.auto).toBe(4);
  expect(tmap.motorcycle).toBe(1);
});

it('type map vclass fallback', () => {
  // Unknown ids map by vClass: passenger->0, bus->2, truck->3.
  const tmap = buildTypeMap(writeTemp(ROU, '.rou.xml'));
  expect(tmap.bangloreCar).toBe(0);
  expect(tmap.schoolbus).toBe(2);
  expect(tmap['water-tanker']).toBe(3);
  expect(tmap.DEFAULT_VEHTYPE).toBe(3);
});

it('type map unknown defaults zero', () => {
  // No vClass and unknown id -> 0 (passenger).
  const tmap = buildTypeMap(writeTemp('<routes><vType id="mystery"/></routes>', '.rou.xml'));
  expect(tmap.mystery).toBe(0);
  expect(VCLASS_TO_IDX.taxi).toBe(4);
});

/* TestPerScenarioSpecs -----------------------------------------------------------
 * pack_run.parseScenarioSpecs: A/B runs take per-scenario net/rou. */

it('per scenario specs', () => {
  // --scenario k=net:rou (repeated) -> per-scenario inputs.
  expect(parseScenarioSpecs(
    ['today=a.net.xml:a.rou.xml', 'proposed=b.net.xml:b.rou.xml'], null, null))
    .toEqual([['today', 'a.net.xml', 'a.rou.xml'],
      ['proposed', 'b.net.xml', 'b.rou.xml']]);
});

it('global net rou single scenario', () => {
  // --net/--rou with bare scenario keys (backward compatible).
  expect(parseScenarioSpecs(['today'], 'n.xml', 'r.xml'))
    .toEqual([['today', 'n.xml', 'r.xml']]);
});

it('global net rou multi key rejected', () => {
  // Bare multi-keys with one global net/rou is the A/B bug — reject.
  expect(() => parseScenarioSpecs(['today', 'proposed'], 'n.xml', 'r.xml'))
    .toThrow();
});

it('mixed specs rejected', () => {
  // One bare + one spec -> error.
  expect(() => parseScenarioSpecs(['today', 'proposed=b.net.xml:b.rou.xml'],
    'n.xml', 'r.xml'))
    .toThrow();
});

it('spec without global ok', () => {
  // All specs carry their own net/rou; globals not required.
  const specs = parseScenarioSpecs(['today=a.net.xml:a.rou.xml'], null, null);
  expect(specs.length).toBe(1);
});

/* TestGeoLockExtraction ----------------------------------------------------------
 * sumo_geom.geoLock: <location> -> (latlngMap, utm). */

const LOC = '<location netOffset="-794602.11,-1431388.13" '
  + 'convBoundary="5.47,0.00,651.33,706.40" '
  + 'origBoundary="77.714521,12.933828,77.721480,12.942221" '
  + 'projParameter="+proj=utm +zone=43 +ellps=WGS84 +datum=WGS84 '
  + '+units=m +no_defs"/>';

it('geo lock from net', () => {
  const net = writeTemp('<?xml version="1.0"?><net>' + LOC + '</net>', '.net.xml');
  const { latlngMap, utm } = geoLock(net);
  expect(latlngMap).not.toBeNull();
  expect(latlngMap.conv).toEqual([5.47, 0.0, 651.33, 706.4]);
  // orig reordered minLng,minLat,maxLng,maxLat -> minLat,minLng,maxLat,maxLng
  expect(latlngMap.orig).toEqual([12.933828, 77.714521, 12.942221, 77.72148]);
  expect(utm.zone).toBe(43);
  expect(utm.south).toBe(false);
  expect(utm.offX).toBeCloseTo(-794602.11, 6);
  expect(utm.offY).toBeCloseTo(-1431388.13, 6);
});

it('geo lock none for hand net', () => {
  // sample.net.xml has -1e10 sentinel origBoundary -> no geo lock.
  const { latlngMap, utm } = geoLock(path.join(FIXDIR, 'sample.net.xml'));
  expect(latlngMap).toBeNull();
  expect(utm).toBeNull();
});

/* TestPackerEndToEnd -------------------------------------------------------------
 * End-to-end test of the packer CLI. */

it('packer cli help', () => {
  const r = spawnSync(process.execPath, [PACK_RUN, '--help'], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain('pack_run.js');
  expect(r.stdout).toContain('--net');
  expect(r.stdout).toContain('--rou');
  expect(r.stdout).toContain('-o');
});

it('packer requires net and rou', () => {
  // Missing --scenario (and -o-less runs) must exit non-zero.
  const r = spawnSync(process.execPath,
    [PACK_RUN, '-o', path.join(os.tmpdir(), 'simo-cli-test.simo.json')],
    { encoding: 'utf8' });
  expect(r.status).not.toBe(0);
});

/* TestDemandReading --------------------------------------------------------------
 * blgr_pack.readDemand: sum of contributor flow rates (veh/hr). */

it('demand sums per hour', () => {
  const rou = writeTemp(`<routes>
    <flow id="a" perHour="200.5" route="r0" begin="0" end="3600"/>
    <flow id="b" perHour="320" route="r1" begin="0" end="3600"/>
  </routes>`, '.rou.xml');
  expect(readDemand(rou)).toBeCloseTo(520.5, 6);
});

it('demand vehs per hour alias', () => {
  // SUMO's older vehsPerHour spelling is honoured too.
  const rou = writeTemp(`<routes>
    <flow id="a" vehsPerHour="100" route="r0" begin="0" end="3600"/>
    <flow id="b" perHour="50" route="r1" begin="0" end="3600"/>
  </routes>`, '.rou.xml');
  expect(readDemand(rou)).toBeCloseTo(150.0, 6);
});

it('demand ignores standalone vehicles', () => {
  // <vehicle> elements are one-off departures, not an hourly rate.
  const rou = writeTemp(`<routes>
    <flow id="a" perHour="100" route="r0" begin="0" end="3600"/>
    <vehicle id="v0" depart="0" route="r0"/>
    <vehicle id="v1" depart="5" route="r0"/>
  </routes>`, '.rou.xml');
  expect(readDemand(rou)).toBeCloseTo(100.0, 6);
});

it('demand empty routes zero', () => {
  const rou = writeTemp('<routes/>', '.rou.xml');
  expect(readDemand(rou)).toBe(0.0);
});

/* TestPackDemand ------------------------------------------------------------------
 * buildPack emits demand (rou rate) + peakServed (stats arrived). */

function scen(stats) {
  return { frames: [[]], stats,
    geometry: { lanes: [], arms: {}, phases: [], stops: {}, links: {} },
    geo: null };
}

it('pack has demand and peak served', () => {
  const statsA = [[0, 0, 0, 0, 0], [150, 3, 2, 40, 0]];     // arrived 150
  const statsB = [[0, 0, 0, 0, 0], [230, 5, 1, 60, 0]];     // arrived 230
  const out = buildPack({
    today: { ...scen(statsA), demand: 3228.84 },
    proposed: { ...scen(statsB), demand: 3228.84 },
  }, 2);
  expect(out.demand).toBeCloseTo(3228.84, 6);
  expect(out.peakServed, 'max across scenarios').toBe(230);
});

it('pack demand none when no flows', () => {
  // No flow data -> demand key is null (wizard/injector falls back).
  const out = buildPack({
    today: { ...scen([[0, 0, 0, 0, 0], [10, 1, 0, 5, 0]]), demand: null },
  }, 2);
  expect(out.demand).toBeNull();
  expect(out.peakServed).toBe(10);
});

it('buildPack bounds survive vehicle-frame counts beyond the spread limit',
  () => {
    /* regression: bounds used Math.min(...xs) — past V8's spread-argument
     * limit (~65k records) that throws "Maximum call stack size exceeded".
     * Real corridor runs (hundreds of vehicles x 900 frames) cross it. */
    const N = 1000000;
    const frames = Array.from({ length: N },
      (_, i) => [[1, i % 30000, 200, 90, 80, 0]]);
    const out = buildPack({
      today: { frames, stats: [[0, 0, 0, 0, 0]],
        geometry: { lanes: [], arms: {}, phases: [], stops: {}, links: {} },
        geo: null },
    }, 900);
    expect(out.bounds).toEqual([0, 200, 29999, 200]);
    expect(out.peakServed).toBe(0);
  });

it('packFcd rejects unrepresentable records with a clear error', () => {
  /* the blob is i16 dm (+-3276.7 m) / u16 ids; a net without coordinate
   * normalization must fail with an actionable message, not the raw
   * Buffer ERR_OUT_OF_RANGE stack. */
  expect(() => packFcd([[[1, 400000, 200, 90, 80, 0]]]))
    .toThrow(/x=400000 dm exceeds i16 dm/);
  expect(() => packFcd([[[1, 100, -400000, 90, 80, 0]]]))
    .toThrow(/y=-400000 dm exceeds i16 dm/);
  expect(() => packFcd([[[70000, 100, 200, 90, 80, 0]]]))
    .toThrow(/vehicle id 70000 out of u16/);
});

/* dev_inject ---------------------------------------------------------------------
 * slug/statsDerive helpers + idempotent CATALOG patch (dev_inject.py
 * contract): same id replaces, the one-line data.js format is preserved. */

it('dev inject slug and stats derive', () => {
  expect(slug('My Test Run')).toBe('my-test-run');
  expect(slug('!!!')).toBe('sim');
  const b64 = Buffer.from(packStats([[0, 1, 0, 0, 0], [5, 1, 0, 2, 0]]))
    .toString('base64');
  expect(statsDerive(b64)).toEqual({ arrived: 5, qmax: 2 });
});

it('dev inject is idempotent on id', () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-inject-'));
  const dataPath = path.join(td, 'data.js');
  fs.writeFileSync(dataPath, 'const OTHER_SIMS = [];\nconst CATALOG = [];\n');
  const pack = {
    nFrames: 2,
    bounds: [0, 0, 100, 200],
    scenarios: {
      today: {
        lanes: [{ p: [[0, 0], [100, 0]], w: 3.2 }],
        frames: Buffer.from(packFcd([[[1, 100, 200, 45, 40, 0]], []]))
          .toString('base64'),
        stats: Buffer.from(packStats([[0, 1, 0, 0, 0], [5, 1, 0, 2, 0]]))
          .toString('base64'),
      },
    },
  };
  const packPath = path.join(td, 'pack.simo.json');
  fs.writeFileSync(packPath, JSON.stringify(pack));
  const opts = { playerDir: td, packPath, title: 'Test Run', author: 'qa' };

  injectPack(opts);
  injectPack(opts);          // second run replaces, never duplicates

  const src = fs.readFileSync(dataPath, 'utf8');
  expect(src, 'patched data.js must keep the one-line const CATALOG format')
    .toMatch(/^const CATALOG = .*;\s*$/m);
  const catalog = readCatalog(src);
  expect(catalog.length).toBe(1);
  expect(catalog[0].id).toBe('test-run');
  expect(catalog[0].title).toBe('Test Run');
  expect(catalog[0].author).toBe('qa');
  expect(catalog[0].nFrames).toBe(2);
  expect(catalog[0].scenarios.today.stats,
    'stats must ride inline in the catalog entry').toBeTruthy();
  // writeCatalog round-trip stays parseable
  expect(readCatalog(writeCatalog(src, catalog)).length).toBe(1);

  const streamSrc = fs.readFileSync(path.join(td, 'streams', 'test-run.js'), 'utf8');
  const m = streamSrc.match(
    /^window\.__simoStreamCallback\('test-run',\s*(\{.*\})\);\s*$/s);
  expect(m, 'stream file must be a JSONP payload for the injected id')
    .not.toBeNull();
  const payload = JSON.parse(m[1]);
  expect(payload.nFrames).toBe(2);
  expect(payload.scenarios.today.frames).toBeTruthy();
});

/* dev_inject wizard metadata ---------------------------------------------------
 * --desc/--anchor/--rotation/--suggested-zoom (plan task 4): a reloaded
 * entry keeps the wizard's placement/description for NON-geo-locked nets.
 * Geo-locked nets derive anchor/zone/bounds from latlngMap — the flags only
 * fill the fallback path (desc always rides along). */

function metaPack(scenarioExtras) {
  return {
    nFrames: 2,
    bounds: [0, 0, 100, 200],
    scenarios: {
      today: {
        lanes: [{ p: [[0, 0], [100, 0]], w: 3.2 }],
        frames: Buffer.from(packFcd([[[1, 100, 200, 45, 40, 0]], []]))
          .toString('base64'),
        stats: Buffer.from(packStats([[0, 1, 0, 0, 0], [5, 1, 0, 2, 0]]))
          .toString('base64'),
        ...scenarioExtras,
      },
    },
  };
}

function injectWithMeta(scenarioExtras) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-inject-meta-'));
  const dataPath = path.join(td, 'data.js');
  fs.writeFileSync(dataPath, 'const CATALOG = [];\n');
  const packPath = path.join(td, 'pack.simo.json');
  fs.writeFileSync(packPath, JSON.stringify(metaPack(scenarioExtras)));
  injectPack({
    playerDir: td, packPath, title: 'Meta Run', author: 'qa', id: 'meta-run',
    desc: 'wizard description',
    anchor: [13.5, 77.6],
    rotation: 9,
    suggestedZoom: 17,
  });
  return readCatalog(fs.readFileSync(dataPath, 'utf8'))
    .find((e) => e.id === 'meta-run');
}

it('dev inject metadata fills the non-geo-locked fallback path', () => {
  const e = injectWithMeta(null);
  expect(e.desc).toBe('wizard description');
  expect(e.anchor).toEqual([13.5, 77.6]);   // not the hardcoded fallback
  expect(e.rotation).toBe(9);
  expect(e.suggestedZoom).toBe(17);
  expect(e.scenarios.today).not.toHaveProperty('geoLocked');
});

it('dev inject metadata does not override geo-locked placement', () => {
  /* latlngMap orig [12.933828, 77.714521, 12.942221, 77.72148] -> bounds
   * centre anchor; rotation pinned to 0; desc still carried. */
  const e = injectWithMeta({
    latlngMap: { conv: [5.47, 0.0, 651.33, 706.4],
      orig: [12.933828, 77.714521, 12.942221, 77.72148] },
    geoLocked: true,
  });
  expect(e.anchor[0]).toBeCloseTo(12.9380245, 6);
  expect(e.anchor[1]).toBeCloseTo(77.7180005, 6);
  expect(e.rotation).toBe(0);
  expect(e.desc).toBe('wizard description');
  expect(e.scenarios.today.geoLocked).toBe(true);
});

it('dev inject parseArgs reads metadata flags', () => {
  const opts = parseInjectArgs(['pack.simo.json', '--title', 'T',
    '--author', 'qa', '--id', 'x', '--net', 'n.xml', '--desc', 'wizard text',
    '--anchor', '13.5,77.6', '--rotation', '9', '--suggested-zoom', '17']);
  expect(opts.packPath).toBe('pack.simo.json');
  expect(opts.title).toBe('T');
  expect(opts.desc).toBe('wizard text');
  expect(opts.anchor).toEqual([13.5, 77.6]);
  expect(opts.rotation).toBe(9);
  expect(opts.suggestedZoom).toBe(17);
});

it('dev inject parseArgs defaults metadata flags', () => {
  const opts = parseInjectArgs(['pack.simo.json', '--title', 'T']);
  expect(opts.desc).toBeUndefined();
  expect(opts.anchor).toBeUndefined();
  expect(opts.rotation).toBeUndefined();
  expect(opts.suggestedZoom).toBeUndefined();
});
