/* Tests for tools/pack_fcd.js — pack an EXISTING FCD+summary run into
 * .simo.json without re-running SUMO.
 *
 * This is the ChatSUMO-Agent replay path: the agent runs headless sumo
 * (plain or TraCI-controlled, possibly with injected events), then hands
 * the produced fcd.xml/summary.xml + net + routes to pack_fcd.js. The
 * packer must never spawn SUMO itself (a re-run would lose the injected
 * events) and must accept arbitrary fcd/summary paths — unlike pack_run.js,
 * which runs SUMO with fixed <tag>-fcd.xml naming in its own tempdir.
 *
 * Integration style: a REAL headless sumo run on the mini fixtures, then
 * the pack_fcd.js CLI on the produced outputs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findSumo } from '../tools/sumo_geom.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

const FIXDIR = path.join(PLAYER_ROOT, 'test', 'fixtures');
const PACK_FCD = path.join(PLAYER_ROOT, 'tools', 'pack_fcd.js');
const NET = path.join(FIXDIR, 'mini.net.xml');
const ROU = path.join(FIXDIR, 'mini.rou.xml');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pack-fcd-test-'));
}

/* Real headless SUMO run producing fcd + summary (the agent-side contract). */
function runSumo(dir, end) {
  const fcd = path.join(dir, 'fcd.xml');
  const summ = path.join(dir, 'sum.xml');
  const r = spawnSync(findSumo(), [
    '-n', NET, '-r', ROU,
    '--fcd-output', fcd, '--summary-output', summ,
    '--end', String(end),
    '--no-step-log', '--no-warnings',
  ], { encoding: 'utf8' });
  expect(r.status, `sumo failed: ${r.stderr}`).toBe(0);
  return { fcd, summ };
}

function packFcd(args) {
  return spawnSync(process.execPath, [PACK_FCD, ...args], { encoding: 'utf8' });
}

describe('pack_fcd.js', () => {
  it('packs existing fcd+summary into .simo.json without re-running SUMO', async () => {
    const dir = tmpdir();
    const { fcd, summ } = runSumo(dir, 20);
    const out = path.join(dir, 'run.simo.json');

    const r = packFcd([
      '--net', NET, '--rou', ROU,
      '--fcd', fcd, '--summary', summ,
      '--scenario', 'chat', '-o', out,
    ]);
    expect(r.status, `pack_fcd failed: ${r.stderr}`).toBe(0);

    const pack = JSON.parse(fs.readFileSync(out, 'utf8'));
    /* sim ran to --end 20, so timesteps 0..19 exist -> 20 frames */
    expect(pack.nFrames).toBe(20);
    expect(pack.demand).toBe(150); /* flow 120 + flow 30 from mini.rou.xml */

    const sc = pack.scenarios.chat;
    expect(sc.lanes.length).toBeGreaterThan(0);
    expect(sc.stats).toBeDefined();

    /* frames blob: per frame u16 count + count * 9-byte records; frame 0
     * has vehicles (flow starts at t=0) */
    const frames = Buffer.from(sc.frames, 'base64');
    const nVehFrame0 = frames.readUInt16LE(0);
    expect(nVehFrame0).toBeGreaterThan(0);

    /* stats blob: nFrames rows * 5 u16 */
    expect(Buffer.from(sc.stats, 'base64').length).toBe(10 * pack.nFrames);

    /* non-geo net (projParameter="!"): no geo-lock, recentered to origin */
    expect(sc.geoLocked).toBeUndefined();
    expect(sc.latlngMap).toBeUndefined();
    let sx = 0, sy = 0, n = 0;
    for (const l of sc.lanes) for (const p of l.p) { sx += p[0]; sy += p[1]; n += 1; }
    expect(Math.abs(sx / n)).toBeLessThan(1);
    expect(Math.abs(sy / n)).toBeLessThan(1);

    /* vehicle coords live inside the recentered lane bounds */
    const xs = [], ys = [];
    for (const l of sc.lanes) for (const p of l.p) { xs.push(p[0]); ys.push(p[1]); }
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    let off = 2; /* skip frame-0 header */
    for (let i = 0; i < nVehFrame0; i++) {
      const x = frames.readInt16LE(off + 2);
      const y = frames.readInt16LE(off + 4);
      expect(x).toBeGreaterThanOrEqual(minX - 60); /* 6m slack, dm */
      expect(x).toBeLessThanOrEqual(maxX + 60);
      expect(y).toBeGreaterThanOrEqual(minY - 60);
      expect(y).toBeLessThanOrEqual(maxY + 60);
      off += 9;
    }
  });

  it('derives nFrames from the fcd when --end is omitted', () => {
    const dir = tmpdir();
    const { fcd, summ } = runSumo(dir, 20);
    const out = path.join(dir, 'run.simo.json');

    const r = packFcd([
      '--net', NET, '--rou', ROU,
      '--fcd', fcd, '--summary', summ,
      '--scenario', 'chat', '-o', out,
    ]);
    expect(r.status, `pack_fcd failed: ${r.stderr}`).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).nFrames).toBe(20);
  });

  it('caps frames at --end when the fcd runs longer', () => {
    const dir = tmpdir();
    const { fcd, summ } = runSumo(dir, 60);
    const out = path.join(dir, 'run.simo.json');

    const r = packFcd([
      '--net', NET, '--rou', ROU,
      '--fcd', fcd, '--summary', summ,
      '--scenario', 'chat', '-o', out, '--end', '20',
    ]);
    expect(r.status, `pack_fcd failed: ${r.stderr}`).toBe(0);
    const pack = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(pack.nFrames).toBe(20);
    /* records beyond the cap are dropped, not packed */
    const frames = Buffer.from(pack.scenarios.chat.frames, 'base64');
    let off = 0, recs = 0;
    while (off < frames.length) {
      const n = frames.readUInt16LE(off);
      recs += n;
      off += 2 + n * 9;
    }
    expect(recs).toBeGreaterThan(0);
  });

  it('caps without stretching: --end beyond the fcd clamps to sim length', () => {
    /* A cap longer than the sim must NOT stretch the pack (empty-tail
     * frames are dead playback time); it clamps to the fcd length. */
    const dir = tmpdir();
    const { fcd, summ } = runSumo(dir, 20);
    const out = path.join(dir, 'run.simo.json');

    const r = packFcd([
      '--net', NET, '--rou', ROU,
      '--fcd', fcd, '--summary', summ,
      '--scenario', 'chat', '-o', out, '--end', '900',
    ]);
    expect(r.status, `pack_fcd failed: ${r.stderr}`).toBe(0);
    const pack = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(pack.nFrames).toBe(20);
    expect(Buffer.from(pack.scenarios.chat.stats, 'base64').length).toBe(10 * 20);
  });

  it('rejects missing required args with exit 2', () => {
    const dir = tmpdir();
    const noFcd = packFcd(['--net', NET, '--rou', ROU, '--scenario', 'chat',
      '-o', path.join(dir, 'o.json')]);
    expect(noFcd.status).toBe(2);
    expect(noFcd.stderr).toContain('--fcd');

    const noScenario = packFcd(['--net', NET, '--rou', ROU,
      '--fcd', path.join(dir, 'fcd.xml'), '--summary', path.join(dir, 'sum.xml'),
      '-o', path.join(dir, 'o.json')]);
    expect(noScenario.status).toBe(2);
    expect(noScenario.stderr).toContain('--scenario');
  });
});
