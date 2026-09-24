/* Indian road-behavior vTypes (plan: indian-driving-vtypes) — tests for
 * src/lib/vtypePreset.js, the pure single source of truth for the
 * mandated aggressive-driving vType block:
 *
 *   - injectAggressiveDriving(): EVERY .rou.xml we hand to SUMO carries
 *     the vType family — the car block verbatim, the 20 behavior attrs
 *     forced onto every existing vType (vClass/maxSpeed/length preserved,
 *     so buses stay buses and render classes survive; car-following +
 *     lane-changing + junction-model attrs: jmIgnoreFoeProb/jmTimegapMinor
 *     make vehicles push into busy junctions instead of politely waiting,
 *     and tau stays >= the pipeline step-length 1 — sub-step tau turns
 *     every conflict into a collision teleport and drains all jams), a
 *     DEFAULT_VEHTYPE
 *     override for typeless vehicles, all emitted right after <routes ...>
 *     (SUMO needs DEFAULT_VEHTYPE before any vehicle reference). Idempotent.
 *   - buildPresetRoutesXml(): the contributor preset file (checked in
 *     byte-identical at presets/indian-roads.rou.xml and bundled as the
 *     third entry of the /api/export-net zip).
 *   - render-class + demand semantics survive patching (blgr_pack).
 *   - the patched mini fixture runs through the REAL sumo binary.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BEHAVIOR_ATTRS, CAR_VTYPE_ATTRS, PRESET_FILE_NAME,
  injectAggressiveDriving, buildPresetRoutesXml,
} from '../src/lib/vtypePreset.js';
import { buildTypeMap, readDemand } from '../tools/blgr_pack.js';
import { findSumo } from '../tools/sumo_geom.js';
import { runSumo, deriveSumoHome } from '../tools/pack_run.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const FIXDIR = path.join(PLAYER_ROOT, 'test', 'fixtures');
const ROU_XML = fs.readFileSync(path.join(FIXDIR, 'mini.rou.xml'), 'utf8');
const SUMO = findSumo();

/* writeTemp twin of tools.test.js — a real file so buildTypeMap/readDemand
 * (fs-based) can read the patched bytes. */
function writeTemp(text, suffix) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-vtype-'));
  const p = path.join(td, 'file' + suffix);
  fs.writeFileSync(p, text);
  return p;
}

function tagOf(xml, id) {
  const m = xml.match(new RegExp('<vType id="' + id + '"[^>]*>'));
  return m ? m[0] : null;
}

/* --------------------------------------------------------- module shape */

describe('vtypePreset module shape', () => {
  it('exports the 20 behavior attrs as ordered [key, value] pairs', () => {
    expect(BEHAVIOR_ATTRS.map(([k]) => k)).toEqual([
      'carFollowModel', 'accel', 'decel', 'emergencyDecel', 'tau', 'sigma',
      'laneChangeModel', 'lcSublane', 'latAlignment', 'minGapLat',
      'maxSpeedLat', 'lcStrategic', 'lcCooperative', 'lcSpeedGain',
      'lcKeepRight', 'lcAssertive', 'lcPushy',
      'jmIgnoreFoeProb', 'jmTimegapMinor', 'impatience',
    ]);
    for (const [k, v] of [
      ['accel', '4.5'], ['decel', '6.0'], ['emergencyDecel', '9.0'],
      ['tau', '1.0'], ['sigma', '0.9'], ['lcSublane', '1.0'],
      ['latAlignment', 'arbitrary'], ['minGapLat', '0.2'],
      ['maxSpeedLat', '2.5'], ['lcStrategic', '0.5'],
      ['lcCooperative', '0.0'], ['lcSpeedGain', '9.0'],
      ['lcKeepRight', '0.0'], ['lcAssertive', '2.5'], ['lcPushy', '1.0'],
      ['jmIgnoreFoeProb', '1.0'], ['jmTimegapMinor', '0.5'],
      ['impatience', '1.0'],
    ]) {
      expect(BEHAVIOR_ATTRS).toContainEqual([k, v]);
    }
  });

  it('tau is never below the pipeline step-length (1 s): sub-step tau '
    + 'turns every conflict into a collision teleport and drains all jams',
  () => {
    const tau = Number(BEHAVIOR_ATTRS.find(([k]) => k === 'tau')[1]);
    expect(tau).toBeGreaterThanOrEqual(1.0);
  });

  it('CAR_VTYPE_ATTRS = vClass passenger first + the 20 behavior attrs', () => {
    expect(CAR_VTYPE_ATTRS.length).toBe(21);
    expect(CAR_VTYPE_ATTRS[0]).toEqual(['vClass', 'passenger']);
    expect(CAR_VTYPE_ATTRS.slice(1)).toEqual(BEHAVIOR_ATTRS);
  });

  it('PRESET_FILE_NAME is vtypes.rou.xml', () => {
    expect(PRESET_FILE_NAME).toBe('vtypes.rou.xml');
  });
});

/* -------------------------------------------------- injectAggressiveDriving */

describe('injectAggressiveDriving', () => {
  const BARE = `<?xml version="1.0" encoding="UTF-8"?>
<routes>
    <route id="r0" edges="A0B0 B0B1"/>
    <vehicle id="v0" route="r0" depart="1"/>
</routes>`;

  it('injects car (all 21 attrs) + DEFAULT_VEHTYPE (20, no vClass) into a '
    + 'vType-less rou', () => {
    const out = injectAggressiveDriving(BARE);
    const car = tagOf(out, 'car');
    expect(car, 'car vType synthesized').toBeTruthy();
    for (const [k, v] of CAR_VTYPE_ATTRS) {
      expect(car, `car carries ${k}="${v}"`).toContain(` ${k}="${v}"`);
    }
    const def = tagOf(out, 'DEFAULT_VEHTYPE');
    expect(def, 'DEFAULT_VEHTYPE override synthesized').toBeTruthy();
    for (const [k, v] of BEHAVIOR_ATTRS) {
      expect(def, `DEFAULT_VEHTYPE carries ${k}="${v}"`).toContain(
        ` ${k}="${v}"`);
    }
    expect(def).not.toContain('vClass=');
    /* vehicle element untouched — it inherits DEFAULT_VEHTYPE now */
    expect(out).toContain('<vehicle id="v0" route="r0" depart="1"/>');
  });

  it('emits DEFAULT_VEHTYPE, car, then remaining vTypes in document order, '
    + 'right after the <routes ...> open tag (4-space indent, one per line)',
  () => {
    const out = injectAggressiveDriving(ROU_XML);
    const order = ['DEFAULT_VEHTYPE', 'car', 'passenger', 'bus'].map((id) =>
      out.indexOf(`<vType id="${id}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    /* the block sits immediately after the open tag, before any demand */
    expect(out.indexOf('<vType id="DEFAULT_VEHTYPE"'))
      .toBeGreaterThan(out.indexOf('<routes>'));
    expect(out.indexOf('<vType id="DEFAULT_VEHTYPE"'))
      .toBeLessThan(out.indexOf('<route id="r0"'));
    for (const m of out.matchAll(/<vType /g)) {
      const lineStart = out.lastIndexOf('\n', m.index) + 1;
      expect(out.slice(lineStart, m.index), 'vTypes are one per line, '
        + '4-space indented').toBe('    ');
    }
  });

  it('works when <routes> carries attributes', () => {
    const WITH_ATTRS = `<?xml version="1.0" encoding="UTF-8"?>
<routes xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" `
      + `xsi:noNamespaceSchemaLocation="http://sumo.dlr.de/xsd/routes_file.xsd">
    <vehicle id="v0" route="r0" depart="1"/>
    <route id="r0" edges="A0B0"/>
</routes>`;
    const out = injectAggressiveDriving(WITH_ATTRS);
    expect(out).toContain('<vType id="DEFAULT_VEHTYPE"');
    expect(out.indexOf('<vType id="DEFAULT_VEHTYPE"'))
      .toBeGreaterThan(out.indexOf('<routes xmlns:xsi='));
    expect(out.indexOf('<vType id="DEFAULT_VEHTYPE"'))
      .toBeLessThan(out.indexOf('<vehicle id="v0"'));
    expect(out).toContain('<vehicle id="v0" route="r0" depart="1"/>');
  });

  it('mini.rou.xml: bus keeps vClass/maxSpeed, gains the behavior attrs '
    + 'including the junction model; passenger patched too', () => {
    const out = injectAggressiveDriving(ROU_XML);
    const bus = tagOf(out, 'bus');
    expect(bus).toBeTruthy();
    expect(bus, 'render class survives').toContain('vClass="bus"');
    expect(bus, 'physical params survive').toContain('maxSpeed="11.0"');
    expect(bus).toContain(' accel="4.5"');
    expect(bus).toContain(' decel="6.0"');
    expect(bus).toContain(' tau="1.0"');
    expect(bus).toContain(' lcPushy="1.0"');
    expect(bus, 'barges into busy junctions').toContain(
      ' jmIgnoreFoeProb="1.0"');
    expect(bus).toContain(' jmTimegapMinor="0.5"');
    expect(bus).toContain(' impatience="1.0"');
    const pass = tagOf(out, 'passenger');
    expect(pass).toBeTruthy();
    expect(pass).toContain('maxSpeed="13.9"');
    expect(pass).toContain(' lcAssertive="2.5"');
    expect(pass).toContain(' lcPushy="1.0"');
  });

  it('pre-existing <vType id="car" accel="1.0"/> is overridden: exactly one '
    + 'car vType, our accel, no duplicate attrs', () => {
    const src = `<?xml version="1.0" encoding="UTF-8"?>
<routes>
    <vType id="car" accel="1.0"/>
    <route id="r0" edges="A0B0"/>
    <vehicle id="v0" type="car" route="r0" depart="1"/>
</routes>`;
    const out = injectAggressiveDriving(src);
    expect((out.match(/<vType id="car"/g) || []).length).toBe(1);
    const car = tagOf(out, 'car');
    expect(car).toContain(' accel="4.5"');
    expect(car).not.toContain('accel="1.0"');
    for (const [k] of CAR_VTYPE_ATTRS) {
      const hits = car.match(new RegExp('\\b' + k + '="', 'g'));
      expect(hits.length, `single ${k}= in the car tag`).toBe(1);
    }
  });

  it('paired vType with <param> children: attrs merged, children preserved',
    () => {
      const src = `<?xml version="1.0" encoding="UTF-8"?>
<routes>
    <vType id="bus" vClass="bus" maxSpeed="11.0">
        <param key="has.rerouting" value="true"/>
    </vType>
    <route id="r0" edges="A0B0"/>
    <flow id="f0" type="bus" route="r0" begin="0" end="600"
        vehsPerHour="30"/>
</routes>`;
      const out = injectAggressiveDriving(src);
      expect(out).toContain('<param key="has.rerouting" value="true"/>');
      expect(out).toContain('</vType>');
      const bus = tagOf(out, 'bus');
      expect(bus).toContain('vClass="bus"');
      expect(bus).toContain('maxSpeed="11.0"');
      expect(bus).toContain(' tau="1.0"');
      expect(bus).toContain(' jmIgnoreFoeProb="1.0"');
      /* the flow must NOT be swallowed by the paired-form matcher */
      expect(out).toContain('<flow id="f0" type="bus"');
    });

  it('vTypeDistribution element stays intact; its child vTypes are patched '
    + 'in place (not hoisted)', () => {
    const src = `<?xml version="1.0" encoding="UTF-8"?>
<routes>
    <vTypeDistribution id="mix">
        <vType id="bus" vClass="bus" accel="1.2"/>
        <vType id="moto" vClass="motorcycle"/>
    </vTypeDistribution>
    <route id="r0" edges="A0B0"/>
    <flow id="f0" type="mix" route="r0" begin="0" end="600"
        vehsPerHour="60"/>
</routes>`;
    const out = injectAggressiveDriving(src);
    const dist = out.match(/<vTypeDistribution[\s\S]*?<\/vTypeDistribution>/);
    expect(dist, 'the distribution element survives').toBeTruthy();
    expect(dist[0]).toContain('id="bus"');
    expect(dist[0]).toContain('id="moto"');
    expect(dist[0], 'children patched in place').toContain(' accel="4.5"');
    expect(dist[0]).toContain(' lcPushy="1.0"');
    /* the flow must survive */
    expect(out).toContain('<flow id="f0" type="mix"');
  });

  it('idempotent: f(f(x)) === f(x) on mini.rou.xml and on the preset', () => {
    const once = injectAggressiveDriving(ROU_XML);
    expect(injectAggressiveDriving(once)).toBe(once);
    const preset = buildPresetRoutesXml();
    expect(injectAggressiveDriving(preset)).toBe(preset);
  });

  it('CRLF demand (netedit on Windows): idempotent — removed vType lines '
    + 'take their CR along and the re-emitted block uses the file EOL', () => {
    const src = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<routes>',
      '    <vType id="bus" vClass="bus"/>',
      '    <route id="r0" edges="A0B0"/>',
      '    <vehicle id="v0" type="bus" route="r0" depart="1"/>',
      '</routes>',
    ].join('\r\n') + '\r\n';
    const once = injectAggressiveDriving(src);
    expect(injectAggressiveDriving(once)).toBe(once);
    /* no orphan CR: every \r is the first half of a CRLF pair */
    expect(once.match(/\r(?!\n)/g)).toBeNull();
    /* the file stays pure CRLF — no LF-only lines introduced */
    expect(once.match(/(?<!\r)\n/g)).toBeNull();
  });

  it('CRLF demand (netedit on Windows): idempotent, no orphan CR bytes — '
    + 'removed vType lines take their CRLF terminator with them and the '
    + 're-emitted block uses the file\'s own EOL', () => {
    const src = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<routes>',
      '    <vType id="bus" vClass="bus"/>',
      '    <route id="r0" edges="A0B0"/>',
      '    <vehicle id="v0" type="bus" route="r0" depart="1"/>',
      '</routes>',
    ].join('\r\n') + '\r\n';
    const once = injectAggressiveDriving(src);
    expect(injectAggressiveDriving(once)).toBe(once);
    /* every CR is half of a CRLF pair — no orphan \r blank lines */
    expect(once.match(/\r(?!\n)/g) || []).toEqual([]);
    /* the re-emitted block matches the file's EOL */
    expect(once).toContain(
      '<routes>\r\n    <vType id="DEFAULT_VEHTYPE"');
  });

  it('no <routes> open tag -> input returned unchanged', () => {
    const garbage = '<not-a-net>this is garbage</not-a-net>';
    expect(injectAggressiveDriving(garbage)).toBe(garbage);
    expect(injectAggressiveDriving('')).toBe('');
  });

  it('comment-laden car vType (the contributor snippet with <!-- --> between '
    + 'attrs) -> one clean car tag with our values', () => {
    const src = `<?xml version="1.0" encoding="UTF-8"?>
<routes>
    <vType id="car"  <!-- the mandated rash-driver car -->
        vClass="passenger"
        carFollowModel="Krauss"
        <!-- acceleration -->
        accel="4.5"
        decel="6.0"
        emergencyDecel="9.0"
        tau="0.5"
        sigma="0.9"
        laneChangeModel="LC2013"
        lcSublane="1.0"
        latAlignment="arbitrary"
        minGapLat="0.2"
        maxSpeedLat="2.5"
        lcStrategic="0.5"
        lcCooperative="0.0"
        lcSpeedGain="9.0"
        lcKeepRight="0.0"
        lcAssertive="2.5"
        lcPushy="1.0"/>
    <route id="r0" edges="A0B0"/>
    <vehicle id="v0" type="car" route="r0" depart="1"/>
</routes>`;
    const out = injectAggressiveDriving(src);
    expect((out.match(/<vType id="car"/g) || []).length).toBe(1);
    const car = tagOf(out, 'car');
    expect(car, 'comments stripped from the tag head').not.toContain('<!--');
    for (const [k, v] of CAR_VTYPE_ATTRS) {
      expect(car).toContain(` ${k}="${v}"`);
    }
    expect((car.match(/<!--/g) || []).length).toBe(0);
    expect(out).toContain('<vehicle id="v0" type="car" route="r0" '
      + 'depart="1"/>');
  });

  it('render classes + demand survive patching (blgr_pack reads the patched '
    + 'file)', () => {
    const patched = injectAggressiveDriving(ROU_XML);
    const tmap = buildTypeMap(writeTemp(patched, '.rou.xml'));
    expect(tmap.bus).toBe(2);
    expect(tmap.passenger).toBe(0);
    expect(readDemand(writeTemp(patched, '.rou.xml'))).toBe(150);
  });
});

/* --------------------------------------------------- buildPresetRoutesXml */

describe('buildPresetRoutesXml', () => {
  it('carries the header, the usage comment and the 5-class family + '
    + 'DEFAULT_VEHTYPE, each with the 20 behavior attrs', () => {
    const preset = buildPresetRoutesXml();
    expect(preset).toMatch(/^<\?xml/);
    expect(preset).toMatch(/paste/i);
    expect(preset).toMatch(/vtypes\.rou\.xml,demand\.rou\.xml/);
    expect(preset).toMatch(/<routes>/);
    for (const id of ['DEFAULT_VEHTYPE', 'car', 'motorcycle', 'bus', 'truck',
      'auto']) {
      expect(tagOf(preset, id), `preset has <vType id="${id}"`)
        .toBeTruthy();
    }
    const auto = tagOf(preset, 'auto');
    expect(auto, 'auto-rickshaw render class via vClass taxi')
      .toContain('vClass="taxi"');
    expect(tagOf(preset, 'car')).toContain('vClass="passenger"');
    expect(tagOf(preset, 'DEFAULT_VEHTYPE')).not.toContain('vClass=');
    for (const [k, v] of BEHAVIOR_ATTRS) {
      for (const id of ['car', 'motorcycle', 'bus', 'truck', 'auto',
        'DEFAULT_VEHTYPE']) {
        expect(tagOf(preset, id), `${id} carries ${k}="${v}"`)
          .toContain(` ${k}="${v}"`);
      }
    }
  });

  it('parity: presets/indian-roads.rou.xml is byte-identical to the '
    + 'generated preset', () => {
    const checkedIn = fs.readFileSync(
      path.join(PLAYER_ROOT, 'presets', 'indian-roads.rou.xml'), 'utf8');
    expect(checkedIn).toBe(buildPresetRoutesXml());
  });
});

/* ------------------------------------------------------------ real-SUMO smoke */

it.skipIf(!SUMO)('real-SUMO smoke: patched mini.rou.xml runs and emits FCD '
  + 'vehicle records', () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-vtype-smoke-'));
  const patched = path.join(td, 'patched.rou.xml');
  fs.writeFileSync(patched, injectAggressiveDriving(ROU_XML));
  const fcdOut = path.join(td, 'fcd.xml');
  const summOut = path.join(td, 'sum.xml');
  /* runSumo throws with SUMO's stderr on any nonzero exit — the generated
   * XML must satisfy the real parser */
  runSumo(SUMO, path.join(FIXDIR, 'mini.net.xml'), patched, fcdOut, summOut,
    600, deriveSumoHome(SUMO, process.env));
  const fcd = fs.readFileSync(fcdOut, 'utf8');
  expect(fcd).toContain('<vehicle');
  expect(fs.readFileSync(summOut, 'utf8')).toContain('<step');
});
