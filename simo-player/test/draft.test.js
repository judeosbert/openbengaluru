/* Port of test_mock.py tests 7, 8 + test_app.js tests 23 (approve part), 27,
 * 28, 30 — upload chip classification, the approveDraft moderation step, and
 * defaultSimMeta slot geometry / sub labels. approveDraft/defaultSimMeta are
 * called directly as imported functions with plain state objects (no vm, no
 * React stub needed). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { approveDraft, defaultSimMeta } from '../src/lib/draft.js';
import { defaultZonePoly } from '../src/lib/geo.js';
import { classifyUploadFile } from '../src/lib/netxml.js';
import { readDataConsts, PLAYER_ROOT } from './helpers/dataConsts.js';

const FIXDIR = path.join(PLAYER_ROOT, 'test', 'fixtures');

// test_mock.py 7 (harness "chips" command -> direct classifier calls) ----------
it('bundle placeholder roundtrip', () => {
  const fixtures = ['sample.rou.xml', 'sample.net.xml', 'sample.sumocfg', 'notes.txt'];
  for (const f of fixtures) {
    expect(fs.existsSync(path.join(FIXDIR, f)), `fixture missing: ${f}`).toBe(true);
  }
  const pairs = fixtures.map((f) => [f, fs.statSync(path.join(FIXDIR, f)).size]);
  pairs.push(['UPPER.ROU.XML', 12]);      // case-insensitive extension
  const out = pairs.map(([name, size]) => classifyUploadFile(name, size));
  expect(out.length).toBe(pairs.length);
  const kinds = out.map((r) => (r == null ? null : r.kind));
  expect(kinds, `classifier results: ${JSON.stringify(kinds)}`)
    .toEqual(['routes', 'network', null, null, 'routes']);
  for (const r of out) {
    if (r === null) continue;   // .sumocfg / notes.txt rejected by classifier
    expect(r.size, `${r.name}: size must survive`).toBeGreaterThan(0);
    expect(r).toHaveProperty('name');
  }
});

// test_mock.py 8 --------------------------------------------------------------
it('approve flow', () => {
  const draft = {
    username: 'test.rider',
    files: [{ name: 'x.rou.xml', size: 10, kind: 'routes' }],
    latlng: [12.9601, 77.7502],
    rotation: 5,
    title: 'Harness Test Junction',
    desc: 'approve-flow fixture',
    simMeta: { demand: 1200, peakServed: 640, nFrames: 900,
      scenarios: { today: {
        title: 'TODAY', sub: 'fixture',
        lanes: [{ p: [[0, 0], [500, 0]], w: 3.2 }],
        phases: [] } } },
  };
  const state = { catalog: readDataConsts().CATALOG };
  const before = state.catalog.length;
  const next = approveDraft(state, draft);
  const last = next.catalog[next.catalog.length - 1];
  expect(next.catalog.length, 'catalog did not grow by exactly 1').toBe(before + 1);
  expect(state.catalog.length === before && !state.catalog.includes(last),
    'approveDraft mutated the previous catalog array').toBe(true);
  expect(next.view).toBe('submissions');
  expect(next.draftSub === null || next.draftSub === undefined,
    'draftSub not cleared').toBe(true);
  expect(last.author).toBe('test.rider');
  expect(last.title).toBe('Harness Test Junction');
  expect(last.anchor).toEqual([12.9601, 77.7502]);
  expect(next.activeSimId, 'active panel must focus the new entry').toBe(last.id);
  expect(!!(last && last.scenarios
    && Object.values(last.scenarios).every((s) => (s.lanes || []).length > 0)),
    'approved entry must carry scenario lanes').toBe(true);
});

// test_app.js 23 (approve part; parse part lives in netxml.test.js) ------------
it('geolock snap', () => {
  /* approveDraft: a geo-locked draft publishes with bounds + bbox zonePoly
   * (replacing the default 40 m square) so the map can auto-snap on open. */
  const geo = {
    lanes: [{ p: [[0, 0], [100, 200]], w: 3.2 }],
    arms: {}, phases: [], stops: {}, links: {},
    latlngMap: { conv: [0, 0, 657.05, 606.79], orig: [12.93, 77.71, 12.94, 77.72] },
    anchor: [12.935, 77.715],
    geoLocked: true,
    suggestedZoom: 15,
  };
  const simMeta = {
    demand: 1000, peakServed: 500, nFrames: 900, zonePoly: null,
    scenarios: { today: { title: 'TODAY', lanes: geo.lanes, phases: [] } },
  };
  const approve = (g) => {
    const draft = {
      username: 'snap.tester', title: 'Snap Area', desc: '',
      latlng: null, rotation: 0, geo: { today: g, proposed: null }, simMeta,
    };
    const next = approveDraft({ catalog: [] }, draft);
    return next.catalog[next.catalog.length - 1];
  };
  const e = approve(geo);
  expect(JSON.stringify(e.bounds),
    'entry.bounds = orig bbox [[minLat,minLng],[maxLat,maxLng]]: '
    + JSON.stringify(e.bounds)).toBe(JSON.stringify([[12.93, 77.71], [12.94, 77.72]]));
  expect(JSON.stringify(e.zonePoly),
    'entry.zonePoly = bbox rectangle corners: ' + JSON.stringify(e.zonePoly))
    .toBe(JSON.stringify([[12.93, 77.71], [12.93, 77.72], [12.94, 77.72], [12.94, 77.71]]));
  expect(e.suggestedZoom,
    'entry.suggestedZoom rides along from the draft geo: ' + e.suggestedZoom).toBe(15);

  /* same geo WITHOUT the zoom comment: bounds + zonePoly still set, and the
   * suggestedZoom key is omitted entirely (fitBounds uses its default cap). */
  const geoNoZoom = { ...geo };
  delete geoNoZoom.suggestedZoom;
  const e2 = approve(geoNoZoom);
  expect(JSON.stringify(e2.bounds),
    'bounds set without zoom too: ' + JSON.stringify(e2.bounds))
    .toBe(JSON.stringify([[12.93, 77.71], [12.94, 77.72]]));
  expect(Array.isArray(e2.zonePoly) && e2.zonePoly.length === 4,
    'zonePoly rectangle set without zoom too').toBe(true);
  expect('suggestedZoom' in e2,
    'no zoom comment -> no suggestedZoom key, got ' + JSON.stringify(e2.suggestedZoom))
    .toBe(false);
});

// test_app.js 27 --------------------------------------------------------------
it('default sim meta slot geo', () => {
  const todayGeo = {
    lanes: [{ p: [[0, 0], [100, 0]], w: 3.2 }], arms: {}, phases: [],
    stops: {}, links: {},
  };
  const propGeo = {
    lanes: [{ p: [[0, 0], [200, 0]], w: 3.5 }], arms: {}, phases: [],
    stops: {}, links: {},
  };
  const meta = defaultSimMeta({
    title: 'Slots Test',
    geo: { today: todayGeo, proposed: propGeo },
    demandCount: 73,
  });
  expect(meta.scenarios && meta.scenarios.today, 'scenarios.today must exist')
    .toBeTruthy();
  expect(meta.scenarios.today.lanes, 'today lanes come from draft.geo.today')
    .toBe(todayGeo.lanes);
  expect(meta.scenarios.proposed,
    'scenarios.proposed must exist when a proposed net is present').toBeTruthy();
  expect(meta.scenarios.proposed.lanes, 'proposed lanes come from draft.geo.proposed')
    .toBe(propGeo.lanes);
  expect(meta.demand, 'demand = draft.demandCount when finite, got ' + meta.demand)
    .toBe(73);
  expect(Number.isInteger(meta.peakServed) && meta.peakServed > 0,
    'peakServed stays synthetic').toBe(true);

  /* proposed absent -> only today published */
  const meta1 = defaultSimMeta({
    title: 'Slots Test 1', geo: { today: todayGeo, proposed: null },
    demandCount: 0,
  });
  expect(!!meta1.scenarios.today && !meta1.scenarios.proposed,
    'no proposed net -> no scenarios.proposed key').toBe(true);
  expect(meta1.demand, 'demandCount 0 is a finite number -> demand 0').toBe(0);

  /* no demandCount -> hash fallback (old behaviour) */
  const meta2 = defaultSimMeta({
    title: 'Slots Test 2', geo: { today: todayGeo, proposed: null },
  });
  expect(!(Number.isFinite(meta2.demand) && meta2.demand === 0),
    'missing demandCount -> hash fallback demand, got ' + meta2.demand).toBe(true);

  /* today absent -> placeholder cross fallback */
  const meta3 = defaultSimMeta({
    title: 'Slots Test 3', geo: { today: null, proposed: propGeo },
    demandCount: 5,
  });
  expect(meta3.scenarios.today.lanes.length,
    'today null -> placeholder cross fallback (4 lanes)').toBe(4);
  expect(meta3.scenarios.proposed.lanes,
    'proposed still parsed when today is null').toBe(propGeo.lanes);
});

// test_app.js 28 --------------------------------------------------------------
it('approve draft today geo lock', () => {
  /* geo-locked today net: bounds/zonePoly/suggestedZoom must come from
   * draft.geo.today, not from the (absent) draft.geo root. */
  const todayGeo = {
    lanes: [{ p: [[0, 0], [100, 200]], w: 3.2 }],
    arms: {}, phases: [], stops: {}, links: {},
    latlngMap: { conv: [0, 0, 657.05, 606.79], orig: [12.93, 77.71, 12.94, 77.72] },
    anchor: [12.935, 77.715],
    geoLocked: true,
    suggestedZoom: 15,
  };
  const draft = {
    username: 'slot.tester', title: 'Slot Snap', desc: '',
    latlng: null, rotation: 0,
    geo: { today: todayGeo, proposed: null },
    demandCount: 42,
    simMeta: {
      demand: 42, peakServed: 20, nFrames: 900, zonePoly: null,
      scenarios: {
        today: { title: 'TODAY', lanes: todayGeo.lanes, phases: [] },
        proposed: { title: 'PROPOSED', lanes: todayGeo.lanes, phases: [] },
      },
    },
  };
  const next = approveDraft({ catalog: [] }, draft);
  const e = next.catalog[next.catalog.length - 1];
  expect(JSON.stringify(e.bounds),
    'bounds from draft.geo.today orig bbox: ' + JSON.stringify(e.bounds))
    .toBe(JSON.stringify([[12.93, 77.71], [12.94, 77.72]]));
  expect(JSON.stringify(e.zonePoly),
    'zonePoly from draft.geo.today bbox corners: ' + JSON.stringify(e.zonePoly))
    .toBe(JSON.stringify([[12.93, 77.71], [12.93, 77.72], [12.94, 77.72], [12.94, 77.71]]));
  expect(e.suggestedZoom,
    'suggestedZoom rides from draft.geo.today, got ' + e.suggestedZoom).toBe(15);
});

// test_app.js 30 --------------------------------------------------------------
it('default sim meta sub labels preview', () => {
  /* real parsed lanes but no frames: sub must say geometry preview, keep
   * the lane count, and NOT sound like a simulated run */
  const meta = defaultSimMeta({
    title: 'Label Test', demandCount: 10,
    geo: { today: { lanes: [{ p: [[0, 0], [100, 0]], w: 3.2 }] }, proposed: null },
  });
  const sub = meta.scenarios.today.sub;
  expect(/geometry preview/.test(sub) && /not a simulated run/.test(sub),
    'real-lane scenario without frames must be labelled a geometry preview, got: ' + sub)
    .toBe(true);
  expect(sub.includes('1 lanes'), 'sub must keep the lane count, got: ' + sub).toBe(true);
  expect(!/submitted/.test(sub), 'sub must not claim a submitted run, got: ' + sub)
    .toBe(true);
  /* placeholder cross fallback keeps its existing text */
  const ph = defaultSimMeta({
    title: 'Label Test PH', demandCount: 10, geo: { today: null, proposed: null },
  });
  expect(ph.scenarios.today.sub,
    'placeholder branch keeps its fallback text, got: ' + ph.scenarios.today.sub)
    .toBe('submitted bundle · placeholder geometry');
});

/* Wizard cleanup: the manual anchor/rotation steps are gone — the map
 * auto-anchors geo-locked nets from the parsed bounds. A hand net (no
 * provenance) publishes with a harmless fallback placement instead of
 * crashing on a null anchor (defaultZonePoly(null)). */
it('hand-net draft without a pin falls back to the map default centre', () => {
  const todayGeo = {
    lanes: [{ p: [[0, 0], [100, 200]], w: 3.2 }],
    arms: {}, phases: [], stops: {}, links: {},
  };
  const draft = {
    username: 'hand.tester', title: 'Hand Net', desc: '',
    latlng: null, rotation: 0,
    geo: { today: todayGeo, proposed: null },
    demandCount: 7,
    simMeta: {
      demand: 7, peakServed: 3, nFrames: 900, zonePoly: null,
      scenarios: { today: { title: 'TODAY', lanes: todayGeo.lanes, phases: [] } },
    },
  };
  const e = approveDraft({ catalog: [] }, draft).catalog[0];
  expect(e.anchor, 'hand nets anchor at the map default centre')
    .toEqual([12.94, 77.72]);
  expect(e.zonePoly, 'fallback 40 m square zone around the fallback anchor')
    .toEqual(defaultZonePoly([12.94, 77.72]));
  expect(e.rotation).toBe(0);
});

/* Data-source provenance rides from the draft onto the published entry. */
it('approveDraft rides the data source provenance onto the entry', () => {
  const draft = {
    username: 'prov.tester', title: 'Provenance', desc: '',
    latlng: [12.96, 77.74], rotation: 0,
    dataSource: 'manual_survey',
    sourceUrl: 'https://docs.example.com/counts',
    geo: { today: null, proposed: null }, demandCount: 5,
    simMeta: {
      demand: 5, peakServed: 2, nFrames: 900, zonePoly: null,
      scenarios: { today: { title: 'TODAY', lanes: [], phases: [] } },
    },
  };
  const e = approveDraft({ catalog: [] }, draft).catalog[0];
  expect(e.dataSource).toBe('manual_survey');
  expect(e.sourceUrl).toBe('https://docs.example.com/counts');
});
