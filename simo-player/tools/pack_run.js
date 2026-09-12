#!/usr/bin/env node
/* Contributor packer: run SUMO, pack FCD+summary to BLGR, emit .simo.json.
 *
 * Port of tools/pack_run.py. Single scenario:
 *     pack_run.js --net n.xml --rou r.xml --scenario today -o out.simo.json
 *
 * A/B (each scenario has its own net + routes):
 *     pack_run.js --scenario today=t.net.xml:t.rou.xml \
 *                 --scenario proposed=p.net.xml:p.rou.xml -o out.simo.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findSumo as findSumoBinary, geom, geoLock } from './sumo_geom.js';
import {
  buildTypeMap, readDemand, packFcd, packStats, readFcd, readSummary,
} from './blgr_pack.js';

/* Exact flag list from video_capture.py:34-38 — locked by test/tools.test.js
 * (seed 42, step-length 1). */
export const SUMO_FLAGS = [
  '--fcd-output', '{fcd}',
  '--fcd-output.geo', 'false',
  '--summary-output', '{summ}',
  '--seed', '42',
  '--step-length', '1',
  '--time-to-teleport', '300',
  '--max-depart-delay', '1800',
  '-e', '{end}',
  '--no-step-log', '--no-warnings',
];

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(2);
}

export function usage() {
  return `usage: pack_run.js [-h] --scenario SCENARIO -o OUTPUT [--net NET] [--rou ROU]
                    [--cfg CFG] [--end END] [--sumo SUMO]

Pack a SUMO run into .simo.json

options:
  --net NET               SUMO network file (single-scenario form)
  --rou ROU               SUMO routes file (single-scenario form)
  --cfg CFG               SUMO config (.sumocfg) supplying net/rou
  --scenario SCENARIO     Scenario key, or key=net.xml:rou.xml for A/B.
                          Repeatable.
  -o OUTPUT, --output OUTPUT
                          Output .simo.json path
  --end END               Simulation end time (seconds)
  --sumo SUMO             Path to sumo binary (auto-discovered if omitted)`;
}

export function parseArgs(argv) {
  const opts = { scenario: [], end: 900 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`argument ${a}: expected one argument`);
      return argv[i];
    };
    if (a === '--help' || a === '-h') {
      process.stdout.write(usage() + '\n');
      process.exit(0);
    } else if (a === '--net') opts.net = next();
    else if (a === '--rou') opts.rou = next();
    else if (a === '--cfg') opts.cfg = next();
    else if (a === '--scenario') opts.scenario.push(next());
    else if (a === '-o' || a === '--output') opts.output = next();
    else if (a === '--end') {
      const v = Number(next());
      if (!Number.isFinite(v)) fail('argument --end: invalid int value');
      opts.end = Math.trunc(v);
    } else if (a === '--sumo') opts.sumo = next();
    else fail(`unrecognized argument: ${a}`);
  }
  if (!opts.scenario.length) fail('the following arguments are required: --scenario');
  if (!opts.output) fail('the following arguments are required: -o/--output');
  return opts;
}

/* Normalize --scenario values into [(key, net_path, rou_path), ...].
 *
 * Two forms, never mixed:
 *   bare keys        -> global --net/--rou (single scenario only)
 *   key=net:rou      -> per-scenario inputs (A/B) */
export function parseScenarioSpecs(scenarioArgs, net, rou) {
  const specs = [];
  const keyed = scenarioArgs.map((s) => s.includes('='));
  if (keyed.some((k) => k) && !keyed.every((k) => k)) {
    throw new Error('mixing bare scenario keys and key=net:rou specs');
  }
  if (keyed.every((k) => k)) {
    for (const s of scenarioArgs) {
      const eq = s.indexOf('=');
      const key = s.slice(0, eq);
      const paths = s.slice(eq + 1);
      const c = paths.lastIndexOf(':');
      const n = c === -1 ? '' : paths.slice(0, c);
      const r = c === -1 ? '' : paths.slice(c + 1);
      if (!key || !n || !r) {
        throw new Error(`bad --scenario spec: ${JSON.stringify(s)} `
          + '(want key=net.xml:rou.xml)');
      }
      specs.push([key, n, r]);
    }
  } else {
    if (!net || !rou) {
      throw new Error('bare --scenario keys require --net and --rou');
    }
    if (scenarioArgs.length > 1) {
      throw new Error(
        'multiple scenarios share one net/rou — an A/B run needs '
        + 'per-scenario specs: --scenario today=t.net.xml:t.rou.xml '
        + '--scenario proposed=p.net.xml:p.rou.xml');
    }
    specs.push([scenarioArgs[0], net, rou]);
  }
  const keys = specs.map(([k]) => k);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`duplicate scenario keys: ${JSON.stringify(keys)}`);
  }
  return specs;
}

/* Run SUMO with exact flags from video_capture.py:34-38. */
export function runSumo(sumo, net, rou, fcdOut, summOut, endTime, sumoHome) {
  const cmd = [sumo, '-n', net, '-r', rou];
  for (const flag of SUMO_FLAGS) {
    if (flag === '{fcd}') cmd.push(fcdOut);
    else if (flag === '{summ}') cmd.push(summOut);
    else if (flag === '{end}') cmd.push(String(endTime));
    else cmd.push(flag);
  }
  const r = spawnSync(cmd[0], cmd.slice(1), {
    encoding: 'utf8',
    env: sumoHome ? { ...process.env, SUMO_HOME: sumoHome } : process.env,
  });
  if (r.status !== 0) {
    throw new Error(`SUMO failed: ${(r.stderr || '').slice(-800)}`);
  }
  return true;
}

/* Assemble the .simo.json dict.
 *
 * scenarios_data: {key: {frames, stats, geometry, geo, demand}} where geo is
 * sumo_geom.geoLock()'s {latlngMap, utm} or null. Scenario entries follow
 * the catalog shape: lanes/arms/phases/stops/links + frames/stats (base64)
 * + latlngMap/utm/geoLocked when provenance exists. Top level adds demand
 * (max scenario rate) and peakServed (max final arrived across scenarios)
 * — matching build_mock's catalog semantics. */
export function buildPack(scenariosData, nFrames) {
  const outScenarios = {};
  /* running min/max — Math.min(...xs) overflows the call stack once the
   * packed record count passes V8's spread-argument limit (~65k; a
   * gridlocked corridor run over 900 frames reaches millions). */
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let anchor = null;
  const demands = [];
  let peakServed = 0;
  for (const [key, d] of Object.entries(scenariosData)) {
    if (d.demand != null) demands.push(d.demand);
    if (d.stats && d.stats.length) {
      peakServed = Math.max(peakServed, d.stats[d.stats.length - 1][0]);
    }
    const geometry = d.geometry;
    const geo = d.geo || null;
    const latlngMap = geo ? geo.latlngMap : null;
    const utm = geo ? geo.utm : null;
    const framesBlob = packFcd(d.frames);
    const statsBlob = packStats(d.stats);
    const sc = { title: key.toUpperCase(),
      lanes: geometry.lanes, arms: geometry.arms || {},
      phases: geometry.phases || [],
      stops: geometry.stops || {}, links: geometry.links || {},
      frames: Buffer.from(framesBlob).toString('base64'),
      stats: Buffer.from(statsBlob).toString('base64') };
    if (latlngMap) {
      sc.latlngMap = latlngMap;
      sc.geoLocked = true;
      if (anchor === null) {
        const o = latlngMap.orig;
        anchor = [(o[0] + o[2]) / 2, (o[1] + o[3]) / 2];
      }
    }
    if (utm) {
      sc.utm = utm;
      sc.geoLocked = true;
    }
    outScenarios[key] = sc;
    for (const frame of d.frames) {
      for (const v of frame) {
        if (v[1] < minX) minX = v[1];
        if (v[2] < minY) minY = v[2];
        if (v[1] > maxX) maxX = v[1];
        if (v[2] > maxY) maxY = v[2];
      }
    }
  }
  const bounds = Number.isFinite(minX)
    ? [minX, minY, maxX, maxY] : [0, 0, 1, 1];
  return { nFrames, bounds, anchor,
    demand: demands.length ? Math.max(...demands) : null,
    peakServed,
    scenarios: outScenarios };
}

export async function main(argv) {
  const args = parseArgs(argv);

  let net = args.net, rou = args.rou;
  if (args.cfg) {
    const cfg = fs.readFileSync(args.cfg, 'utf8');
    const cfgDir = path.dirname(path.resolve(args.cfg));
    const nf = /<net-file\b[^>]*\bvalue\s*=\s*"([^"]+)"/.exec(cfg);
    const rf = /<route-files\b[^>]*\bvalue\s*=\s*"([^"]+)"/.exec(cfg);
    if (!nf || !rf) fail('error: net-file/route-files missing in config');
    net = path.join(cfgDir, nf[1]);
    rou = path.join(cfgDir, rf[1]);
  }

  let specs;
  try {
    specs = parseScenarioSpecs(args.scenario, net, rou);
  } catch (e) {
    fail(`error: ${e.message}`);
  }

  const sumo = args.sumo || findSumoBinary();
  if (!sumo) fail('error: sumo not found. Set --sumo or $SUMO_HOME');

  let sumoHome = null;
  if (process.env.SUMO_HOME) {
    sumoHome = process.env.SUMO_HOME;
  } else if (sumo.startsWith('/Library/Frameworks/EclipseSUMO.framework/')) {
    sumoHome = '/Library/Frameworks/EclipseSUMO.framework/'
      + 'Versions/Current/EclipseSUMO/share/sumo';
  }

  const scenariosData = {};
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'simo-pack-'));
  for (const [key, netPath, rouPath] of specs) {
    const fcdOut = path.join(td, `${key}-fcd.xml`);
    const summOut = path.join(td, `${key}-sum.xml`);
    process.stdout.write(`  Running SUMO for '${key}' (${path.basename(netPath)})...\n`);
    runSumo(sumo, netPath, rouPath, fcdOut, summOut, args.end, sumoHome);
    const tmap = buildTypeMap(rouPath);
    const [frames, nVeh] = await readFcd(key, td, args.end, tmap);
    const stats = await readSummary(key, td, args.end);
    process.stdout.write(`    ${nVeh} vehicles, ${frames.length} frames, `
      + `${Object.keys(tmap).length} vTypes\n`);
    scenariosData[key] = {
      frames, stats,
      geometry: geom(netPath),
      geo: geoLock(netPath),
      demand: readDemand(rouPath),
    };
  }

  const out = buildPack(scenariosData, args.end);
  fs.writeFileSync(args.output, JSON.stringify(out));
  const kb = (fs.statSync(args.output).size / 1024).toFixed(1);
  process.stdout.write(`Wrote ${args.output} (${kb} KB)`
    + (out.anchor ? ' [geo-locked]' : '') + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((e) => fail(String((e && e.stack) || e)));
}
