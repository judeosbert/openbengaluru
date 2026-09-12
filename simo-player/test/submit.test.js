/* Payload-builder tests for the server-submit flow (plan: real SUMO
 * simulation for wizard-submitted entries).
 *
 * The pure contract lives in src/lib/submit.js (DOM-free, node-testable):
 *   - buildSimulateRequest(draft) -> POST /api/simulate body
 *   - serverAvailable(loc)        -> http(s) pages get real sims,
 *                                    file:// keeps the preview-only path
 * The raw-file-retention + simulating-state wiring in SubmitFlow/store is
 * pinned with source-regex checks (html.test.js precedent — component glue
 * is not directly testable in the node environment).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildSimulateRequest, serverAvailable } from '../src/lib/submit.js';
import { entryIdFor, slugTitle } from '../src/lib/draft.js';
import { PLAYER_ROOT } from './helpers/dataConsts.js';

/* entryIdFor --------------------------------------------------------------- */

it('entryIdFor is slug + base36 timestamp', () => {
  const id = entryIdFor('Kundalahalli peak U-turn ban');
  expect(id).toMatch(/^kundalahalli-peak-u-turn-ban-[0-9a-z]+$/);
  const suffix = id.slice(slugTitle('Kundalahalli peak U-turn ban').length + 1);
  expect(parseInt(suffix, 36)).toBeGreaterThan(0);
  expect(entryIdFor('!!!')).toMatch(/^sim-[0-9a-z]+$/);
});

/* buildSimulateRequest ------------------------------------------------------ */

function fullDraft() {
  return {
    username: 'balagere-traffic',
    files: {
      demand: { name: 'peak.rou.xml', size: 10, kind: 'routes',
        text: '<routes><vehicle id="v0" depart="0"/></routes>' },
      today: { name: 'today.net.xml', size: 20, kind: 'network',
        text: '<net version="1.16"><location/></net>' },
      proposed: { name: 'proposed.net.xml', size: 30, kind: 'network',
        text: '<net version="1.16"/>' },
    },
    geo: { today: {}, proposed: null },
    demandCount: 42,
    latlng: [12.93966, 77.71930],
    rotation: 5,
    title: 'Kundalahalli peak U-turn ban',
    desc: 'Ban the U-turn at peak hours',
    simMeta: null,
  };
}

it('buildSimulateRequest carries the full wizard bundle', () => {
  const d = fullDraft();
  const body = buildSimulateRequest(d, 'kundalahalli-peak-u-turn-ban-abc123');
  expect(body).toEqual({
    id: 'kundalahalli-peak-u-turn-ban-abc123',
    title: 'Kundalahalli peak U-turn ban',
    author: 'balagere-traffic',
    desc: 'Ban the U-turn at peak hours',
    rouXml: '<routes><vehicle id="v0" depart="0"/></routes>',
    todayNetXml: '<net version="1.16"><location/></net>',
    proposedNetXml: '<net version="1.16"/>',
    anchor: [12.93966, 77.71930],
    rotation: 5,
  });
});

it('buildSimulateRequest omits proposedNetXml without a proposed slot', () => {
  const d = fullDraft();
  delete d.files.proposed;
  const body = buildSimulateRequest(d, 'x');
  expect(body).not.toHaveProperty('proposedNetXml');
});

it('buildSimulateRequest omits anchor when no pin was placed', () => {
  const d = fullDraft();
  d.latlng = null;
  const body = buildSimulateRequest(d, 'x');
  expect(body).not.toHaveProperty('anchor');
  expect(body.rotation).toBe(5);
});

it('buildSimulateRequest defaults missing raw text to empty strings', () => {
  const d = fullDraft();
  d.files.demand.text = undefined;
  const body = buildSimulateRequest(d, 'x');
  expect(body.rouXml).toBe('');
  expect(body.todayNetXml).toBe('<net version="1.16"><location/></net>');
});

it('buildSimulateRequest defaults rotation to 0', () => {
  const d = fullDraft();
  d.rotation = undefined;
  const body = buildSimulateRequest(d, 'x');
  expect(body.rotation).toBe(0);
});

it('buildSimulateRequest defaults desc to empty string', () => {
  const d = fullDraft();
  d.desc = '';
  const body = buildSimulateRequest(d, 'x');
  expect(body.desc).toBe('');
});

/* serverAvailable ------------------------------------------------------------ */

describe('serverAvailable', () => {
  it('http/https pages can get real sims', () => {
    expect(serverAvailable({ protocol: 'http:' })).toBe(true);
    expect(serverAvailable({ protocol: 'https:' })).toBe(true);
  });
  it('file:// (no server) keeps the geometry-preview path', () => {
    expect(serverAvailable({ protocol: 'file:' })).toBe(false);
    expect(serverAvailable(null)).toBe(false);
    expect(serverAvailable(undefined)).toBe(false);
  });
});

/* wiring pins (html.test.js-style source checks) ------------------------------ */

describe('browser wiring', () => {
  it('SubmitFlow stores the raw upload text on every slot record', () => {
    const s = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'components', 'SubmitFlow.js'), 'utf8');
    expect(s,
      'addSlot must keep the FileReader text on the slot record: '
      + '[slot]: { ...c, text }')
      .toMatch(/\[slot\]:\s*\{\s*\.\.\.c,\s*text\s*\}/);
  });

  it('SubmitFlow disables submit and shows the simulating state', () => {
    const s = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'components', 'SubmitFlow.js'), 'utf8');
    expect(s, 'submit button must disable while simulating')
      .toMatch(/disabled:\s*store\.submitting/);
    expect(s, 'submit button must label the simulating state')
      .toMatch(/Simulating/);
  });

  it('store.submitDraft posts to /api/simulate on http and reloads on 200', () => {
    const s = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'state', 'store.js'), 'utf8');
    expect(s, 'submit flow must build the server payload')
      .toMatch(/buildSimulateRequest/);
    expect(s, 'submit flow must gate on serverAvailable')
      .toMatch(/serverAvailable\(/);
    expect(s, 'a 200 response must reload the player into the real sim')
      .toMatch(/location\.reload\(\)/);
    expect(s, 'the POST must hit /api/simulate')
      .toMatch(/['"]\/api\/simulate['"]/);
  });
});
