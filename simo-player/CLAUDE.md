# CLAUDE.md — simo-player

Bengaluru traffic lab player: React 18 + Leaflet + Vite. Migrated from a
single-file `app.js` (React UMD + Babel standalone) to ESM modules under Vite;
generated data + JSONP streams are served from `public/`.

## Commands

- `npm run dev` — vite dev server (http://localhost:5173)
- `npm run build` / `npm run preview` — production build / serve `dist/`
- `npm start` — player server (http://127.0.0.1:8787, `PORT` env overrides):
  static hosting (player dir over dist/) + `POST /api/simulate`.
  **Real wizard simulations require opening the player via this server
  URL** — on `file://` (or vite-only origins without the endpoint) a submit
  falls back to a geometry-only preview entry.
- `npm test` — vitest, single run (alias: `npx vitest run`)
- `npm run test:watch` — vitest watch
- `node tools/pack_run.js --net n.xml --rou r.xml --scenario today -o out.simo.json`
- `node tools/dev_inject.js pack.simo.json --title "My run" [--net n.xml]`
  `  [--player-dir DIR] [--desc D] [--anchor LAT,LNG] [--rotation N] [--suggested-zoom N]`
- Opt-in determinism check: `SIMO_REGEN=1 npx vitest run test/data-regen.test.js`

Node ≥18 required. npm 11 warns on node 20.11 — harmless.

## Layout

- `src/lib/` — pure logic (engine, netxml, geo, draft, submit, areaExport,
  util). **Must stay DOM-free and react/leaflet-free** — enforced by
  `test/lib-purity.test.js`. New pure logic goes here so vitest's node
  environment can run it directly.
- `src/data.js` — adapter over the classic-script bundle `public/data.js`.
  `index.html` loads `/data.js` as a classic script BEFORE the module entry
  (classic blocks, modules defer — order is guaranteed). Script-level `const`
  bindings are global *lexical* bindings, NOT `globalThis` properties; the
  adapter reads them via aliased bare identifiers to dodge TDZ.
- `src/state/store.js` — useTrafficStore + MapProvider/MapOverlayProvider
  (localStorage-guarded username; mergeStream swaps the entry OBJECT).
- `src/map/overlay.js` — Leaflet layer + canvas overlay (react/leaflet live
  here and in components, never in src/lib). `loadSimStream` keeps the JSONP
  script-injection contract; `streams/<id>.js` is a relative URL that
  resolves in dev and build.
- `src/components/` + `src/main.js` — UI; main.js injects
  BALAGERE_CSS_STYLE + EXTRA_CSS then `ReactDOM.createRoot`.
- `tools/*.js` — packer/injector, ports of the retired Python tools:
  `sumo_geom.js` (geom/geoLock/findSumo), `blgr_pack.js` (BLGR packing,
  readline XML parsing), `pack_run.js` (exact SUMO_FLAGS — seed 42,
  step-length 1; argparse-parity CLI), `dev_inject.js` (idempotent CATALOG
  patch + stream writer; wizard metadata flags fill the non-geo-locked
  fallback placement).
- `server.js` — zero-dependency player server: static hosting (public/ over
  dist/) + `POST /api/simulate`, which shells the real pipeline
  (`pack_run.js` → `dev_inject.js`) in a per-request tempdir. Fully
  synchronous (spawnSync) — concurrent simulates serialize; 413/422/500/504
  per the contract at the top of the file. `test/endpoint.test.js` runs it
  with REAL SUMO against a temp player dir.
- `test/` — vitest suites + `helpers/{streamPayload,dataConsts}.js`;
  fixtures in `test/fixtures/` (sample.net.xml has the -1e10 sentinel
  origBoundary; mini.net.xml/mini.rou.xml are a real SUMO-runnable pair
  used by the endpoint suite).

## Generated artifacts — do not hand-edit

- `public/data.js` — emitted by `../sim/build_player.py --export-mock
  public/data.js`. Format contract: every top-level definition is ONE line
  `const NAME = <valid JSON>;` (tests and dev_inject regex-parse it; the
  external generator's byte-stability depends on it).
- `public/streams/<id>.js` — single line
  `window.__simoStreamCallback('<id>',<JSON>);`. JSONP is deliberate;
  fetch() is not a drop-in (tests assert the format).

Blob formats (locked by round-trip tests in test/tools.test.js):
frames = per frame u16LE n + n×9-byte records
`<u16 id, i16 x, i16 y, u8 angle/2, u8 speed*8, u8 type>` (x/y are i16 dm);
stats = nFrames × 5 u16LE `[through, moving, stopped, queued, gridlock]`.
Coordinates are decimetres (metres ×10) everywhere in player geometry.

## Testing conventions

- TDD: write failing tests against planned module paths first, run them,
  confirm the red reason, then implement.
- Assertions are ports of the retired Python/vm suites and pin exact values
  (UTM ground truth `12.9396644, 77.7192996`, recentering offsets, sentinel
  handling). Do not loosen them.
- `test/catalog.test.js` pins `GENERATED_IDS` (the 9 generated sims) rather
  than a hard count: a dev-injected 10th entry may legitimately ride along.
- `test/html.test.js` locks the TrafficMap attach-effect dep array
  `}, [entry, scenKey, map]);` (regex) — preserve it exactly when touching
  src/map/TrafficMap.js.
- The vitest environment is `node` (no jsdom) — that IS the DOM-free
  guarantee for src/lib; don't add a DOM environment to make a lib test pass.
