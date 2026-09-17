#!/usr/bin/env node
/* Pack an EXISTING FCD+summary run into .simo.json — no SUMO re-run.
 *
 * ChatSUMO-Agent replay path: the agent runs headless sumo itself (plain
 * or TraCI-controlled with injected events) and hands the produced
 * fcd/summary plus net+routes to this tool. pack_run.js re-simulates with
 * locked flags, which would lose injected events — packing is split from
 * simulation so event runs replay faithfully.
 *
 *   pack_fcd.js --net n.xml --rou r.xml --fcd fcd.xml --summary sum.xml \
 *               --scenario chat -o run.simo.json
 *
 * nFrames defaults to (max fcd timestep + 1); --end caps it — records at
 * t >= end are dropped and a cap beyond the sim length clamps to it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { buildTypeMap, readDemand, readFcd, readSummary } from './blgr_pack.js';
import { geom, geoLock } from './sumo_geom.js';
import { buildPack } from './pack_run.js';

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(2);
}

export function usage() {
  return `usage: pack_fcd.js --net NET --rou ROU --fcd FCD --summary SUMMARY
                    --scenario SCENARIO -o OUTPUT [--end END]

Pack an existing SUMO run (FCD + summary) into .simo.json without re-running
SUMO.

options:
  --net NET             SUMO network file
  --rou ROU             SUMO routes file (vTypes + demand)
  --fcd FCD             FCD output produced by the run
  --summary SUMMARY     summary output produced by the run
  --scenario SCENARIO   scenario key in the output pack
  -o OUTPUT, --output OUTPUT
                        Output .simo.json path
  --end END             Cap the frame window (seconds); frames at t >= end
                        are dropped, clamped to the sim length. Default:
                        max fcd timestep + 1`;
}

export function parseArgs(argv) {
  const opts = {};
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
    else if (a === '--fcd') opts.fcd = next();
    else if (a === '--summary') opts.summary = next();
    else if (a === '--scenario') opts.scenario = next();
    else if (a === '-o' || a === '--output') opts.output = next();
    else if (a === '--end') {
      const v = Number(next());
      if (!Number.isFinite(v)) fail('argument --end: invalid int value');
      opts.end = Math.trunc(v);
    } else fail(`unrecognized argument: ${a}`);
  }
  for (const req of ['net', 'rou', 'fcd', 'summary', 'scenario']) {
    if (!opts[req]) fail(`error: the following arguments are required: --${req}`);
  }
  if (!opts.output) fail('error: the following arguments are required: -o/--output');
  if (!fs.existsSync(opts.fcd)) fail(`error: --fcd: file not found: ${opts.fcd}`);
  if (!fs.existsSync(opts.summary)) fail(`error: --summary: file not found: ${opts.summary}`);
  return opts;
}

/* Highest timestep in the fcd, streamed line-by-line (FCDs get big). */
export async function maxTimestep(fcdPath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(fcdPath, 'utf8'),
    crlfDelay: Infinity,
  });
  let max = -1;
  for await (const line of rl) {
    const m = /<timestep\b[^>]*\btime\s*=\s*"([^"]+)"/.exec(line);
    if (m) {
      const t = Math.trunc(parseFloat(m[1]));
      if (t > max) max = t;
    }
  }
  return max;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const key = opts.scenario;

  /* readFcd/readSummary locate inputs as <tag>-fcd.xml / <tag>-sum.xml in
   * one dir — stage copies under those names. */
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-fcd-'));
  const fcdCopy = path.join(td, `${key}-fcd.xml`);
  const sumCopy = path.join(td, `${key}-sum.xml`);
  fs.copyFileSync(opts.fcd, fcdCopy);
  fs.copyFileSync(opts.summary, sumCopy);

  const maxT = await maxTimestep(fcdCopy);
  /* --end caps the window (records at t >= end are dropped) and clamps to
   * the sim length — no stretch, empty-tail frames are dead playback time. */
  let nFrames = maxT + 1;
  if (opts.end != null && opts.end > 0) {
    nFrames = Math.min(opts.end, nFrames);
  }

  const tmap = buildTypeMap(opts.rou);
  const [frames, nVeh] = await readFcd(key, td, nFrames, tmap);
  const stats = await readSummary(key, td, nFrames);

  const pack = buildPack({
    [key]: {
      frames, stats,
      geometry: geom(opts.net),
      geo: geoLock(opts.net),
      demand: readDemand(opts.rou),
    },
  }, nFrames);
  fs.writeFileSync(opts.output, JSON.stringify(pack));

  const kb = (fs.statSync(opts.output).size / 1024).toFixed(1);
  process.stdout.write(`Wrote ${opts.output} (${kb} KB): `
    + `${nVeh} vehicles, ${nFrames} frames (fcd max t=${maxT}`
    + `${opts.end != null ? ', --end cap' : ''}), `
    + `${Object.keys(tmap).length} vTypes\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((e) => fail(String((e && e.stack) || e)));
}
