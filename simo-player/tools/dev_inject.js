#!/usr/bin/env node
/* Dev injector: bridge a .simo.json pack into the player without Phase 3.
 *
 * Port of tools/dev_inject.py. Writes public/streams/<id>.js (JSONP stream
 * payload) and patches the CATALOG const in public/data.js with a catalog
 * entry for the pack (idempotent: same id replaces). Geo-lock provenance is
 * read from the source .net.xml (<location> tag) when --net is given,
 * mirroring parseNetXml.
 *
 * Usage:
 *   dev_inject.js pack.simo.json --net n.xml --title "My run" --author me
 *
 * data.js regen workflow (generated artifact, do not hand-edit):
 *   python3 ../sim/build_player.py --export-mock public/data.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoLock } from './sumo_geom.js';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLAYER_ROOT = path.dirname(TOOL_DIR);
export const DEFAULT_PLAYER_DIR = path.join(PLAYER_ROOT, 'public');

export function slug(title) {
  const s = String(title == null ? '' : title).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'sim';
}

/* (final arrived, max queued) from a packed stats blob. */
export function statsDerive(statsB64) {
  const raw = Buffer.from(statsB64, 'base64');
  const n = Math.floor(raw.length / 10);
  const arrived = raw.readUInt16LE((n - 1) * 10);
  let qmax = 0;
  for (let i = 0; i < n; i++) qmax = Math.max(qmax, raw.readUInt16LE(i * 10 + 6));
  return { arrived, qmax };
}

export function readCatalog(src) {
  const m = /^const CATALOG = (.*);\s*$/m.exec(src);
  if (!m) throw new Error('data.js: no one-line `const CATALOG = ...;` found');
  return JSON.parse(m[1]);
}

export function writeCatalog(src, catalog) {
  const line = 'const CATALOG = ' + JSON.stringify(catalog) + ';';
  let replaced = false;
  const out = src.replace(/^const CATALOG = .*;\s*$/m, () => {
    replaced = true;
    return line;
  });
  if (!replaced) throw new Error('data.js: no one-line `const CATALOG = ...;` found');
  return out;
}

/* Core entry builder — the PURE (no fs) part of the injection: pack ->
 * { entry, streamPayload }. Shared by the CLI (injectPack writes them out)
 * and the SERVER (POST /api/simulate builds the catalog entry + review
 * stream in-process; no player-dir mutation anywhere in the server).
 *
 * Wizard metadata (desc/anchor/rotation/suggestedZoom) rides onto the entry:
 * desc + suggestedZoom always; anchor/rotation only fill the FALLBACK
 * (non-geo-locked) placement path — geo-locked nets derive anchor/zone/
 * bounds from latlngMap and pin rotation to 0. opts.netGeo is the
 * pre-resolved geo provenance ({latlngMap, utm} | null) — buildEntry stays
 * fs-free, the caller resolves it (injectPack from --net, the server from
 * the pack itself). */
export function buildEntry(pack, opts) {
  const o = opts || {};
  const {
    title, author = 'dev', id, desc, anchor, rotation, suggestedZoom,
    dataSource, sourceUrl,
  } = o;
  const netGeo = o.netGeo || { latlngMap: null, utm: null };
  const eid = id || slug(title);

  /* geo provenance: pack-carried per scenario (new packer) wins; --net is
   * the fallback for old packs */
  const scenarios = {};
  let peakServed = 0, qmaxAll = 0, latlngMap = null;
  for (const [key, sc] of Object.entries(pack.scenarios)) {
    const { arrived, qmax } = statsDerive(sc.stats);
    peakServed = Math.max(peakServed, arrived);
    qmaxAll = Math.max(qmaxAll, qmax);
    const sLat = sc.latlngMap || netGeo.latlngMap;
    const sUtm = sc.utm || netGeo.utm;
    latlngMap = latlngMap || sLat;
    const entry = { title: key.toUpperCase(),
      lanes: sc.lanes, arms: sc.arms || {},
      phases: sc.phases || [],
      stops: sc.stops || {},
      links: sc.links || {},
      stats: sc.stats };
    if (sLat) {
      entry.latlngMap = sLat;
      entry.geoLocked = true;
    }
    if (sUtm) {
      entry.utm = sUtm;
      entry.geoLocked = true;
    }
    scenarios[key] = entry;
  }

  let anchor_, zone, bounds;
  if (latlngMap) {
    const orig = latlngMap.orig;
    anchor_ = [(orig[0] + orig[2]) / 2, (orig[1] + orig[3]) / 2];
    zone = [[orig[0], orig[1]], [orig[0], orig[3]],
      [orig[2], orig[3]], [orig[2], orig[1]]];
    bounds = [[orig[0], orig[1]], [orig[2], orig[3]]];
  } else {
    /* fallback placement: wizard metadata flag when present, else the
     * historical hardcoded anchor */
    anchor_ = Array.isArray(anchor) ? anchor.slice() : [12.9517, 77.7894];
    const d = 20 / 111320;
    zone = [[anchor_[0] - d, anchor_[1] - d], [anchor_[0] - d, anchor_[1] + d],
      [anchor_[0] + d, anchor_[1] + d], [anchor_[0] + d, anchor_[1] - d]];
    bounds = null;
  }

  /* demand/peakServed: pack-carried (contributor flow rates) preferred;
   * stats-derived fallback for old packs */
  const demand = pack.demand != null ? pack.demand : peakServed + qmaxAll;
  const peakOut = pack.peakServed || peakServed;

  const entry = { id: eid, title, author,
    anchor: anchor_,
    /* geo-locked nets cannot be rotated; the wizard rotation only applies
     * to the fallback (non-geo-locked) path */
    rotation: latlngMap ? 0 : (rotation || 0),
    demand: Math.round(demand),
    peakServed: peakOut,
    zonePoly: zone,
    addedAt: new Date().toISOString().slice(0, 10),
    nFrames: pack.nFrames,
    scenarios };
  if (desc != null) entry.desc = desc;
  if (suggestedZoom != null) entry.suggestedZoom = suggestedZoom;
  if (bounds) entry.bounds = bounds;
  /* data-source provenance rides onto the entry (SimPanel shows it) */
  if (dataSource != null) {
    entry.dataSource = dataSource;
    if (sourceUrl != null) entry.sourceUrl = sourceUrl;
  }

  /* stream payload (frames only; stats ride inline in the catalog entry) */
  const streamPayload = { nFrames: pack.nFrames, bounds: pack.bounds,
    scenarios: Object.fromEntries(
      Object.entries(pack.scenarios).map(([k, sc]) => [k, { frames: sc.frames }])),
  };
  return { entry, streamPayload };
}

/* Core injection: build the catalog entry + stream payload from a pack and
 * write them. Idempotent on id. Returns a summary object. */
export function injectPack(opts) {
  const playerDir = opts.playerDir || DEFAULT_PLAYER_DIR;
  const dataPath = opts.dataPath || path.join(playerDir, 'data.js');
  const streamsDir = opts.streamsDir || path.join(playerDir, 'streams');
  const { packPath, title, author = 'dev', id, netPath,
    desc, anchor, rotation, suggestedZoom } = opts;

  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));

  /* geo provenance: pack-carried per scenario (new packer) wins; --net is
   * the fallback for old packs */
  const netGeo = netPath ? geoLock(netPath) : { latlngMap: null, utm: null };
  const { entry, streamPayload } = buildEntry(pack, {
    title, author, id, desc, anchor, rotation, suggestedZoom, netGeo,
  });
  const eid = entry.id;

  /* 1) stream file (frames only; stats ride inline in the catalog entry) */
  fs.mkdirSync(streamsDir, { recursive: true });
  const spath = path.join(streamsDir, eid + '.js');
  fs.writeFileSync(spath,
    "window.__simoStreamCallback('" + eid + "',"
    + JSON.stringify(streamPayload) + ');\n');

  /* 2) catalog patch (idempotent on id) */
  const src = fs.readFileSync(dataPath, 'utf8');
  const catalog = readCatalog(src).filter((e) => e.id !== eid);
  catalog.push(entry);
  fs.writeFileSync(dataPath, writeCatalog(src, catalog));

  return { id: eid, entryCount: catalog.length, streamPath: spath,
    dataPath, geoLocked: Object.values(entry.scenarios)
      .some((s) => s.latlngMap != null),
    demand: entry.demand, peakServed: entry.peakServed };
}

export function usage() {
  return `usage: dev_inject.js [-h] pack --title TITLE [--net NET] [--author AUTHOR] [--id ID]
                          [--player-dir DIR] [--desc DESC] [--anchor LAT,LNG]
                          [--rotation N] [--suggested-zoom N]

Inject a .simo.json pack into the player (public/data.js + public/streams/)

positional arguments:
  pack               .simo.json from pack_run.js

options:
  --net NET          source .net.xml (geo-lock provenance)
  --title TITLE      (required)
  --author AUTHOR
  --id ID            catalog id (default: slug of title)
  --player-dir DIR   player public dir (default: <repo>/public)
  --desc DESC        wizard description (catalog entry)
  --anchor LAT,LNG   fallback anchor for non-geo-locked nets
  --rotation N       fallback rotation for non-geo-locked nets
  --suggested-zoom N fitBounds zoom cap written onto the entry`;
}

export function parseArgs(argv) {
  const opts = { author: 'dev' };
  const positional = [];
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
    } else if (a === '--net') opts.netPath = next();
    else if (a === '--title') opts.title = next();
    else if (a === '--author') opts.author = next();
    else if (a === '--id') opts.id = next();
    else if (a === '--player-dir') opts.playerDir = next();
    else if (a === '--desc') opts.desc = next();
    else if (a === '--anchor') {
      const v = next().split(',').map(Number);
      if (v.length !== 2 || !v.every(Number.isFinite)) {
        fail('argument --anchor: expected lat,lng');
      }
      opts.anchor = v;
    } else if (a === '--rotation') {
      const v = Number(next());
      if (!Number.isFinite(v)) fail('argument --rotation: expected a number');
      opts.rotation = v;
    } else if (a === '--suggested-zoom') {
      const v = Number(next());
      if (!Number.isFinite(v)) fail('argument --suggested-zoom: expected a number');
      opts.suggestedZoom = v;
    } else positional.push(a);
  }
  if (!positional.length) fail('the following arguments are required: pack');
  if (!opts.title) fail('the following arguments are required: --title');
  opts.packPath = positional[0];
  return opts;
}

export function main(argv) {
  const opts = parseArgs(argv);
  const r = injectPack(opts);
  process.stdout.write(`entry '${r.id}' -> ${r.dataPath} CATALOG `
    + `(${r.entryCount} entries)\n`);
  const kb = Math.round(fs.statSync(r.streamPath).size / 1024);
  process.stdout.write(`stream -> ${r.streamPath} (${kb} KB)\n`);
  process.stdout.write(`geo-locked: ${r.geoLocked}  demand: ${r.demand}  `
    + `peakServed: ${r.peakServed}\n`);
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
