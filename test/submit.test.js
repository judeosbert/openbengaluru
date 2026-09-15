/* Payload-builder tests for the server-submit flow (plan: real SUMO
 * simulation for wizard-submitted entries).
 *
 * The pure contract lives in src/lib/submit.js (DOM-free, node-testable):
 *   - buildSimulateRequest(draft) -> POST /api/simulate body
 *   - serverAvailable(loc)        -> http(s) pages get real sims,
 *                                    file:// gets the run-via-server hint
 * The raw-file-retention + simulating-state wiring in SubmitFlow/store is
 * pinned with source-regex checks (html.test.js precedent — component glue
 * is not directly testable in the node environment).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildSimulateRequest, serverAvailable, DATA_SOURCES, validSourceUrl,
} from '../src/lib/submit.js';
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
    dataSource: 'manual_survey',
    sourceUrl: 'https://docs.example.com/counts',
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
    dataSource: 'manual_survey',
    sourceUrl: 'https://docs.example.com/counts',
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

it('buildSimulateRequest drops the source url for Approximation', () => {
  const d = fullDraft();
  d.dataSource = 'approximation';
  d.sourceUrl = '';
  const body = buildSimulateRequest(d, 'x');
  expect(body.dataSource).toBe('approximation');
  expect(body).not.toHaveProperty('sourceUrl');
});

/* DATA_SOURCES + validSourceUrl ---------------------------------------------- */

it('DATA_SOURCES enumerates the three provenance options', () => {
  expect(DATA_SOURCES).toEqual(['manual_survey', 'survey_data', 'approximation']);
});

describe('validSourceUrl', () => {
  it('accepts http(s) URLs only', () => {
    expect(validSourceUrl('https://docs.example.com/counts')).toBe(true);
    expect(validSourceUrl('http://localhost:8787/sheet')).toBe(true);
    expect(validSourceUrl('ftp://example.test/x')).toBe(false);
    expect(validSourceUrl('example.test/counts')).toBe(false);
    expect(validSourceUrl('')).toBe(false);
    expect(validSourceUrl(null)).toBe(false);
    expect(validSourceUrl(undefined)).toBe(false);
  });
});

/* serverAvailable ------------------------------------------------------------ */

describe('serverAvailable', () => {
  it('http/https pages can get real sims', () => {
    expect(serverAvailable({ protocol: 'http:' })).toBe(true);
    expect(serverAvailable({ protocol: 'https:' })).toBe(true);
  });
  it('file:// (no server) gets the run-via-server hint — no local publish', () => {
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
    /* the record now comes from the shared pure ingestSlot helper (the
     * same core the resubmit prefill uses) — the FileReader text still
     * rides on the slot record via ingestSlot's fileRecord */
    expect(s,
      'addSlot must delegate classification+parsing to the shared '
      + 'ingestSlot helper')
      .toMatch(/ingestSlot\(\s*slot,\s*f\.name,\s*text\s*\)/);
    expect(s,
      'addSlot must keep the parsed record (with text) on the slot: '
      + '[slot]: r.fileRecord')
      .toMatch(/\[slot\]:\s*r\.fileRecord/);
  });

  it('SubmitFlow disables submit and shows the simulating state', () => {
    const s = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'components', 'SubmitFlow.js'), 'utf8');
    expect(s, 'submit button must disable while simulating')
      .toMatch(/disabled:\s*store\.submitting/);
    expect(s, 'submit button must label the simulating state')
      .toMatch(/Simulating/);
  });

  it('store.submitDraft posts to /api/simulate and lands on the dashboard (NO reload)', () => {
    const s = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'state', 'store.js'), 'utf8');
    expect(s, 'submit flow must build the server payload')
      .toMatch(/buildSimulateRequest/);
    expect(s, 'submit flow must gate on serverAvailable')
      .toMatch(/serverAvailable\(/);
    /* review flow: submissions NEVER go live directly — the row lands
     * pending for admin review, so the old reload is gone; the client
     * toasts and switches to the dashboard instead */
    expect(s, 'a 200 response must NOT reload the player (review flow)')
      .not.toMatch(/location\.reload\(\)/);
    expect(s, 'a 200 response must toast the pending-review state')
      .toMatch(/submitted — pending review/);
    expect(s, 'a 200 response must switch to the dashboard view')
      .toMatch(/setView\('dashboard'\)/);
    expect(s, 'the POST must hit /api/simulate')
      .toMatch(/['"]\/api\/simulate['"]/);
    expect(s, 'resubmission must pin the draft id (draftSub.id before the '
      + 'generated id)')
      .toMatch(/draftSub\.id \|\| entryIdFor\(draftSub\.title\)/);
  });

  it('submit failures set an inline submitError — nothing is published locally', () => {
    const s = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'state', 'store.js'), 'utf8');
    expect(s, 'the geometry-only publish fallback must be gone entirely '
      + '(no fake previews reach the catalog)')
      .not.toMatch(/publishLocally|approveDraft|defaultSimMeta/);
    expect(s, 'server-unavailable submit must surface the run-via-server '
      + 'hint (names npm run dev like ExportFlow)')
      .toMatch(/npm run dev/);
    expect(s, 'the hint must also name npm start')
      .toMatch(/npm start/);
    expect(s, 'an expired sign-in must set the inline submitError')
      .toMatch(/setSubmitError\(/);
    expect(s, 'server error body must surface verbatim (HTTP status as the '
      + 'fallback)')
      .toMatch(/setSubmitError\(body\.error \|\| 'HTTP ' \+ res\.status\)/);
    expect(s, 'a network failure must set submitError from the thrown error')
      .toMatch(/String\(\(e && e\.message\) \|\| e\)/);
    expect(s, 'submitError must be cleared when a new submit starts')
      .toMatch(/setSubmitError\(null\)/);
    expect(s, 'the store must expose submitError to the wizard')
      .toMatch(/submitError/);
  });

  it('SubmitFlow renders the persistent submit error on the review step', () => {
    const s = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'components', 'SubmitFlow.js'), 'utf8');
    expect(s, 'the review step must render store.submitError inline so the '
      + 'wizard stays open and retryable')
      .toMatch(/store\.submitError/);
  });
});

/* wizard: data source + no anchor/rotation steps ------------------------------ */

describe('wizard: data source field + no anchor/rotation steps', () => {
  const sf = () => fs.readFileSync(
    path.join(PLAYER_ROOT, 'src', 'components', 'SubmitFlow.js'), 'utf8');

  it('wizard is 3 steps — the anchor/rotation steps are gone (map auto-anchors)', () => {
    const s = sf();
    expect(s, "no '/5' step counter left").not.toMatch(/'\/5'/);
    expect(s, "step counter is '/3'").toMatch(/'\/3'/);
    expect(s, 'no anchor-step preamble').not.toMatch(/Anchor it to the map/);
    expect(s, 'no rotation-step preamble').not.toMatch(/Rotate the network/);
    expect(s, 'no confirm-anchor button').not.toMatch(/Confirm anchor/);
    expect(s, 'no minimize-&-rotate button').not.toMatch(/Minimize & rotate/);
    expect(s, 'no minimize-&-select button')
      .not.toMatch(/Minimize & select location/);
    expect(s, 'review must not show the ANCHOR row').not.toMatch(/'ANCHOR'/);
    expect(s, 'review must not show the ROTATION row')
      .not.toMatch(/'ROTATION'/);
    /* auto-anchoring survives: geo-locked nets prefill from the parsed
     * bounds — the wizard no longer asks the user to place anything */
    expect(s, 'geo-locked auto anchor prefill kept')
      .toMatch(/placeDraft\(r\.geo\.anchor\)/);
  });

  it('the mandatory data source field reveals the source-link input', () => {
    const s = sf();
    expect(s, 'DATA SOURCE label').toMatch(/DATA SOURCE/);
    expect(s, 'placeholder names the options').toMatch(
      /Choose — Manual survey \/ Survey data \/ Approximation/);
    expect(s, 'manual_survey option').toMatch(/'manual_survey'/);
    expect(s, 'survey_data option').toMatch(/'survey_data'/);
    expect(s, 'approximation option').toMatch(/'approximation'/);
    expect(s, 'SOURCE LINK row (input + review)').toMatch(/SOURCE LINK/);
    expect(s, 'link input gated by the shared validSourceUrl helper')
      .toMatch(/validSourceUrl/);
  });

  it('store: fresh drafts carry empty provenance; resubmit prefills it', () => {
    const s = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'state', 'store.js'), 'utf8');
    expect(s, 'fresh draft defaults dataSource to empty')
      .toMatch(/dataSource:\s*''/);
    expect(s, 'fresh draft defaults sourceUrl to empty')
      .toMatch(/sourceUrl:\s*''/);
    expect(s, 'resubmit prefill reads the stored data_source')
      .toMatch(/sub\.data_source/);
    expect(s, 'resubmit prefill reads the stored source_url')
      .toMatch(/sub\.source_url/);
  });

  it('review surfaces show the data source (panel + both dashboards)', () => {
    const sp = fs.readFileSync(
      path.join(PLAYER_ROOT, 'src', 'components', 'SimPanel.js'), 'utf8');
    expect(sp, 'SimPanel DATA SOURCE row').toMatch(/DATA SOURCE/);
    expect(sp, 'SimPanel links the stored source url')
      .toMatch(/entry\.sourceUrl/);
    for (const view of ['DashboardView.js', 'AdminView.js']) {
      const s = fs.readFileSync(
        path.join(PLAYER_ROOT, 'src', 'components', view), 'utf8');
      expect(s, view + ' shows the stored data_source')
        .toMatch(/row\.data_source/);
      expect(s, view + ' links the stored source_url')
        .toMatch(/row\.source_url/);
    }
  });
});
