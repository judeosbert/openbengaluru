#!/usr/bin/env node
/* Shared geometry extraction from SUMO .net.xml.
 *
 * Direct regex port of tools/sumo_geom.py (itself extracted from
 * sim/build_player.py:geom()) so the contributor packer uses identical
 * logic to the retired Python tooling.
 */
import fs from 'node:fs';

function isExecutableFile(p) {
  try {
    return fs.statSync(p).isFile() && fs.accessSync(p, fs.constants.X_OK) === undefined;
  } catch {
    return false;
  }
}

/* Discover SUMO binary: $SUMO_HOME -> macOS framework -> PATH. */
export function findSumo() {
  const candidates = [
    (process.env.SUMO_HOME || '') + '/bin/sumo',
    '/Library/Frameworks/EclipseSUMO.framework/Versions/Current/EclipseSUMO/share/sumo/bin/sumo',
    'sumo',
  ];
  for (const c of candidates) {
    if (c && isExecutableFile(c)) return c;
  }
  return null;
}

/* <location> -> {latlngMap, utm}, mirroring src/lib/netxml.js parseNetXml.
 *
 * latlngMap: {conv: convBoundary metres, orig: origBoundary reordered to
 * [minLat, minLng, maxLat, maxLng]}. utm: {offX, offY, zone, south}.
 * Each is null when the net lacks usable provenance (hand nets write
 * -1e10 sentinels). */
export function geoLock(netPath) {
  const s = fs.readFileSync(netPath, 'utf8');
  const m = /<location\s[^>]*>/.exec(s);
  if (!m) return { latlngMap: null, utm: null };
  const tag = m[0];

  const attr = (name) => {
    const mm = new RegExp(name + '="([^"]+)"').exec(tag);
    return mm ? mm[1] : null;
  };
  const bbox4 = (v) => {
    if (!v) return null;
    const f = v.split(',').map(parseFloat);
    return f.length === 4 ? f : null;
  };
  const vec2 = (v) => {
    if (!v) return null;
    const f = v.split(',').map(parseFloat);
    return f.length === 2 ? f : null;
  };

  const convB = bbox4(attr('convBoundary'));
  const origB = bbox4(attr('origBoundary'));
  const netOff = vec2(attr('netOffset'));
  const proj = attr('projParameter') || '';

  let latlngMap = null;
  if (convB && origB && origB.every((v) => Math.abs(v) <= 1000)
      && convB[2] > convB[0] && convB[3] > convB[1]
      && origB[2] > origB[0] && origB[3] > origB[1]) {
    latlngMap = { conv: convB,
                  orig: [origB[1], origB[0], origB[3], origB[2]] };
  }

  let utm = null;
  const zm = /\+zone=(\d+)/.exec(proj);
  if (netOff && proj.includes('+proj=utm') && zm
      && 1 <= parseInt(zm[1], 10) && parseInt(zm[1], 10) <= 60) {
    utm = { offX: netOff[0], offY: netOff[1],
            zone: parseInt(zm[1], 10), south: proj.includes('+south') };
  }
  return { latlngMap, utm };
}

/* Extract player geometry from a SUMO .net.xml.
 *
 * Returns object with keys: lanes, arms, phases, stops, links.
 * Lane coordinates converted to decimetres (dm) to match stream format. */
export function geom(netPath) {
  const s = fs.readFileSync(netPath, 'utf8');

  const lanes = [];
  for (const m of s.matchAll(/<lane id="([^:][^"]*)"([^>]*)>?/g)) {
    const attrs = m[2];
    const sh = /shape="([^"]+)"/.exec(attrs);
    if (!sh) continue;
    const w = /width="([\d.]+)"/.exec(attrs);
    /* python: sh.group(1).split() — whitespace-run split, no empties */
    const pts = sh[1].trim().split(/\s+/).map((q) => {
      const v = q.split(',');
      return [Math.round(parseFloat(v[0]) * 10), Math.round(parseFloat(v[1]) * 10)];
    });
    lanes.push({ p: pts, w: w ? parseFloat(w[1]) : 3.2 });
  }

  const ends = {};
  const junctionRe = /<junction id="([^:][^"]*)" type="dead_end" x="([-\d.]+)" y="([-\d.]+)"/g;
  for (const m of s.matchAll(junctionRe)) {
    ends[m[1]] = [Math.round(parseFloat(m[2]) * 10),
                  Math.round(parseFloat(m[3]) * 10)];
  }

  let arms = {};
  if (Object.keys(ends).length) {
    const xs = Object.values(ends).slice().sort((a, b) => a[0] - b[0]);
    const ys = Object.values(ends).slice().sort((a, b) => a[1] - b[1]);
    /* Balagere case-study arm names (from dead_end junction ids) — kept
     * verbatim from sumo_geom.py. */
    arms = { Panathur: xs[0], Varthur: xs[xs.length - 1],
             Sarjapur: ys[0], Kundalahalli: ys[ys.length - 1] };
  }

  const phases = [];
  const stops = {};
  const links = {};

  if (s.includes('<tlLogic')) {
    for (const m of s.matchAll(/<phase duration="([\d.]+)" state="(\w+)"/g)) {
      phases.push([parseFloat(m[1]), m[2]]);
    }
    for (const m of s.matchAll(
      /<connection from="([^"]+)"[^>]*tl="[^"]*"[^>]*linkIndex="(\d+)"/g)) {
      const frm = m[1], idx = parseInt(m[2], 10);
      (links[frm] = links[frm] || []).push(idx);
      const lm = new RegExp('<lane id="' + escapeRe(frm) + '_0"[^>]*shape="([^"]+)"')
        .exec(s);
      if (lm) {
        const last = lm[1].trim().split(/\s+/).pop().split(',');
        stops[frm] = [Math.round(parseFloat(last[0]) * 10),
                      Math.round(parseFloat(last[1]) * 10)];
      }
    }
  }

  return { lanes, arms, phases, stops, links };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
