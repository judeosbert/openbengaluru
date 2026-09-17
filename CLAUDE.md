# CLAUDE.md — OpenBengaluru

OpenBengaluru player ("What would you change?"): React 18 + Leaflet + Vite.
Migrated from a
single-file `app.js` (React UMD + Babel standalone) to ESM modules under Vite;
generated data + JSONP streams are served from `public/`.

## Commands

- `npm run dev` — combined launcher (`tools/dev_all.js`): vite dev server
  (http://localhost:5173) + player server (first free port from 8787;
  vite proxies `/api` to it), so wizard submits on the 5173 origin run the
  real simulation. Loads repo-root `.env` into both children
  (`tools/dotenv.js`; shell env wins, missing file tolerated — server.js
  still fail-fasts listing missing vars).
- `npm run build` / `npm run preview` — production build / serve `dist/`
- `npm start` — player server only (binds 0.0.0.0, `PORT` env overrides 8787;
  LAN-reachable at `http://<your-ip>:8787`):
  static hosting (player dir over dist/) + `POST /api/simulate` +
  `POST /api/export-net`.
  **Needs env first** (Postgres + a bucket backend — `SIMO_BUCKET_DISK_DIR`
  for dev disk storage OR the SIMO_S3_* creds — plus
  `GOOGLE_APPLICATION_CREDENTIALS` (base64 of a service-account JSON,
  not a file path) and the `SIMO_SMTP_*` email values; fails fast listing
  missing vars):
  `cp .env.example .env` then `set -a; . ./.env; set +a; npm start`.
  **Real wizard simulations need either `npm run dev` (proxy wired) or
  opening the player via this server URL** — on `file://` (or vite-only
  origins without the proxy) submit AND export show the run-via-server
  hint; nothing is ever published locally (submit failures keep the wizard
  open with an inline error, catalog untouched).
  Optional worker-pool sizing: `SIMO_WORKER_COUNT` (default cpus−1),
  `SIMO_WORKER_QUEUE_MAX` (default 32 — a full queue answers 503 busy),
  `SIMO_CONVERT_TIMEOUT_MS` (default 120000).
- `npm run db:setup` — creates `PGDATABASE` + `${PGDATABASE}_test` and
  applies `db/schema.sql` (idempotent, transactional). Run twice to confirm
  idempotency; `--no-test-db` skips the test db. (Optional since startup
  self-provisions: the server now applies `db/schema.sql` on boot via
  `db.js ensureDbReady` — a missing database is created through the
  maintenance db, then the schema lands in one transaction; `main()` awaits
  it before `listen` and exits non-zero on failure so the platform
  restarts. The manual step remains useful for provisioning the TEST db
  before running suites.)
- `npm test` — vitest, single run (alias: `npx vitest run`)
- `npm run test:watch` — vitest watch
- `node tools/pack_run.js --net n.xml --rou r.xml --scenario today -o out.simo.json`
- `node tools/dev_inject.js pack.simo.json --title "My run" [--net n.xml]`
  `  [--player-dir DIR] [--desc D] [--anchor LAT,LNG] [--rotation N] [--suggested-zoom N]`
- `node tools/migrate_file_entries.js [--dry-run]` — one-time migration of
  legacy file-baked catalog entries (needs PG* + SIMO_S3_* env): copies
  entry_json + the JSONP stream payload into the DB/bucket for CATALOG
  entries WITH a sims row; entries without rows are dev scratch (skipped).
- Opt-in determinism check: `SIMO_REGEN=1 npx vitest run test/data-regen.test.js`
- Opt-in real-bucket check: `SIMO_TEST_S3_REAL=1` + `SIMO_S3_*` env, then
  `npx vitest run test/bucket.test.js`

Node ≥18 required. npm 11 warns on node 20.11 — harmless.

## Railway deploy (Railpack)

- `railpack.json` (this dir): start command `node server.js` + a `sumo`
  build step that pip-installs the PINNED official wheel
  (`eclipse-sumo==1.27.1`, `--target /app/sumo` via ephemeral mise
  python, build-time version check, `deployOutputs: ["sumo"]`) — it
  ships both `sumo` and `netconvert` plus `data/` for simulate and
  export-net. The apt `sumo` package is GONE: Debian trixie ships SUMO
  1.18, which rejects nets saved by netedit >= 1.20 (net format version
  1.20 — what current netedit users submit), the cause of a real 422.
  `sumoCandidates`/`netconvertCandidates` (tools/sumo_geom.js) order
  discovery SUMO_HOME → `/app/sumo/sumo/bin` → macOS framework → PATH
  (locked by test/tools.test.js); `deriveSumoHome` (tools/pack_run.js)
  replaces the old framework special case. apt `libproj25` stays — the
  wheel bundles libproj but not proj.db, whose baked default
  `/usr/share/proj` the Debian package provides. The explicit start
  command also keeps Railpack's Vite SPA detection from turning the
  deploy into a static Caddy site. Node version resolves from
  `engines.node` (>=18 → latest via mise); pin in the dashboard with
  `RAILPACK_NODE_VERSION` if determinism matters. The git root is the parent
  dir — set the service **Root Directory** to `simo-player`.
- Service variables (server fail-fasts listing missing ones):
  `DATABASE_URL=${{Postgres.DATABASE_URL}}` (or discrete `PG*`),
  bucket backend (`SIMO_S3_*` creds, or `SIMO_BUCKET_DISK_DIR=/data/uploads`
  backed by a Railway volume mounted at `/data`),
  `GOOGLE_APPLICATION_CREDENTIALS` (base64 service-account JSON),
  `SIMO_SMTP_*` email values, `SIMO_ADMIN_EMAILS`. Optional:
  `SIMO_PUBLIC_BASE_URL` (app-root link in notification emails),
  `RAILPACK_PRUNE_DEPS=true` drops devDeps
  (vite/vitest) from the runtime image; `SIMO_WORKER_COUNT` for 1-vCPU
  instances.
- Schema on the Railway Postgres is applied automatically on server boot
  (`ensureDbReady` — creates the database when missing + applies
  `db/schema.sql` idempotently); the one-time manual step
  `DATABASE_URL=<railway pg url> npm run db:setup -- --no-test-db` from
  this dir is now only a fallback.
- `server.js` binds `0.0.0.0:$PORT` (Railway-injected `PORT`, default 8787).

## Layout

- `src/lib/` — pure logic (engine, netxml, geo, draft, submit, areaExport,
  util, profile, catalogMerge, ingestSlot, introScene). **Must stay DOM-free and
  react/leaflet-free** — enforced by `test/lib-purity.test.js`. New pure
  logic goes here so vitest's node environment can run it directly.
  `engine.js` decodes BLGR frames/stats ONLY — the synthetic-traffic
  fallback is gone (frames-less scenarios yield no vehicles and zero
  stats). `draft.js` keeps just the id helpers (`slugTitle`/`entryIdFor`);
  the local publish path is gone.
  `catalogMerge.js` is the two-source merge (base bundle + /api/catalog:
  replace-by-id, API wins, `apiStream` stamp); `ingestSlot.js` is the
  shared upload-ingest core used by SubmitFlow's FileReader path AND the
  resubmit prefill. `areaExport.js` is the server-consumed export head:
  `osmApiUrl` + `validateBbox` (shape/range/min<max/0.25° OSM cap) +
  `sanitizeAreaName` — the client-side convert.sh era is gone.
  `introScene.js` is the intro canvas scene mapping: cover-fit of a fixed
  16:9 reference box (uniform scale, crop overflow) — at exactly 16:9 it
  reduces to the original full-viewport fraction math, so desktop intro
  rendering is unchanged; portrait phones get the scene cut at the sides
  instead of squished (locked by test/intro-scene.test.js).
- `src/data.js` — adapter over the classic-script bundle `public/data.js`.
  `index.html` loads `/data.js` as a classic script BEFORE the module entry
  (classic blocks, modules defer — order is guaranteed). Script-level `const`
  bindings are global *lexical* bindings, NOT `globalThis` properties; the
  adapter reads them via aliased bare identifiers to dodge TDZ.
- `src/state/store.js` — useTrafficStore + MapProvider/MapOverlayProvider
  (Google-auth `user` state via listenAuth; `startDraft` opens the Google
  popup when signed out — the wizard gate; `draft.username` is derived from
  the profile via `authorFromProfile`; mergeStream swaps the entry OBJECT
  and clears `streamErrorId` for that id).
  Review-flow wiring: boot merges `GET /api/catalog` over the base bundle
  (`mergeApiEntries`; failure → base only, file:// keeps base only); `me`
  comes from `GET /api/me` (failure → null, admin UI never appears);
  `previewSubmission(id, status)` plays a non-active sim via a transient
  replace-by-id catalog entry stamped `entry.review` (frames merged in the
  same batched update — the lazy-stream effect never fires for previews);
  `startResubmit(sub)` reopens the wizard prefilled with the id PINNED
  (`draft.id`) and the stored XMLs re-ingested via `ingestSlot`; submit
  success does NOT reload — toast 'submitted — pending review' + view
  `dashboard` (a re-pipeline resets the row to pending, thread preserved);
  submit failure NEVER publishes — every failure path (file://, no token,
  non-OK, network throw) sets `submitError` (inline on the wizard's review
  step, server error text verbatim; cleared on submit start / draft
  open/close), so the wizard stays open and Submit stays retryable;
  `streamErrorId` + `streamFailed(id)` mark an entry whose stream failed
  to load; `activateSim` drops the local `entry.review` stamp;
  `deactivateSim` drops the local entry.
- `src/auth/firebase.js` — Firebase Google sign-in adapter (NOT under
  src/lib): hardcoded public web config, singleton init at module import
  (same pattern as src/data.js). Thin API for the store:
  `signInWithGoogle`, `signOutUser`, `listenAuth`, `currentToken`. No
  analytics. Firebase never appears in src/lib.
- `src/map/overlay.js` — Leaflet layer + canvas overlay (react/leaflet live
  here and in components, never in src/lib). `loadSimStream` keeps the JSONP
  script-injection contract; `streams/<id>.js` is a relative URL that
  resolves in dev and build.
- `src/components/` + `src/main.js` — UI; main.js injects
  BALAGERE_CSS_STYLE + EXTRA_CSS then `ReactDOM.createRoot`. SimPanel runs
  a self-contained fetch of `/api/files/<id>` and renders a FILES download
  block only when the list is non-empty (fetch failure / file:// / route
  missing → section stays hidden, no error UI). SimPanel also renders a
  REVIEW status chip when `entry.review` is stamped (transient previews),
  and gates the numbers block on the active scenario's frames: `streamError`
  → 'simulation data failed to load' note, frames absent → 'loading
  simulation data…' note — no stats call, never fake numbers (API entries
  with inline stats still wait for frames: uniform, always honest).
  Bottom sheet <=900px (CSS media block in EXTRA_CSS): the grip/h2/✕ strip
  is fixed OUTSIDE the scroll — only `.sheet-body` scrolls (base flex:1
  rule keeps the desktop layout); mobile `order` puts Run on top, then
  sliders, then numbers, then FILES. Run on Map collapses the panel to the
  56px title strip (`sheet-collapsed`, touch-action:none — nothing
  scrolls), pointer drag on the strip (threshold snap, `STRIP_PX = 56`) or
  a strip tap re-expands; classes are inert on desktop (side panel
  unchanged). App's `fitPadding` gives the open-snap effect
  `paddingBottomRight` = 62% of the map height <=900px, so the opened
  sheet never covers the sim.
  `DashboardView` (user) + `AdminView` (review queue) are full-screen
  overlay panels over the map, fed by `src/api.js` wrappers; TopBar shows
  Dashboard/Admin only when signed in AND `me` resolved (`me.isAdmin`).
  `ContributeView` is a static full-screen overlay panel (public, no API
  calls) rendering the 6-track/16-role guide copy from the pure
  `src/lib/contribute.js` (`TRACKS` + `LEVELING_UP`; shape locked by
  test/contribute.test.js).
  App's lazy-stream loader branches on `entry.apiStream`:
  `/api/catalog/:id/stream` for API entries, JSONP `streams/<id>.js` for
  the base bundle. Stream failure (fetch reject or JSONP null) is honest:
  `streamFailed(id)` + a toast — the entry stays open on its real lane
  geometry with zero vehicles, SimPanel shows the error note, and
  reopening the entry re-fires the lazy effect (deps `[entry && entry.id]`).
  The old catalog-grow publish-snap effect is deleted (local publishes no
  longer exist).
- `tools/*.js` — packer/injector, ports of the retired Python tools:
  `sumo_geom.js` (geom/geoLock/findSumo), `blgr_pack.js` (BLGR packing,
  readline XML parsing), `pack_run.js` (exact SUMO_FLAGS — seed 42,
  step-length 1; argparse-parity CLI), `dev_inject.js` (idempotent CATALOG
  patch + stream writer; wizard metadata flags fill the non-geo-locked
  fallback placement; the pure `buildEntry(pack, opts)` extraction is
  shared with the server's simulate flow — netGeo is pre-resolved by the
  caller, so buildEntry is fs-free), `migrate_file_entries.js` (one-time
  legacy ride-along migration: entry_json + review stream for CATALOG
  entries with a sims row; --dry-run reports without writing).
- `server.js` — player server: static hosting (public/ over dist/) +
  `POST /api/simulate`, which shells pack_run in a per-request tempdir and
  builds the catalog entry IN-PROCESS via `buildEntry` (NO dev_inject
  subprocess, NO player-dir writes, NO client reload — the server never
  writes public/data.js or public/streams). Auth gate: the request's
  `Authorization: Bearer <Firebase ID token>` is verified via the
  `opts.verifyToken` seam (default `verifyToken.js`: firebase-admin from
  `GOOGLE_APPLICATION_CREDENTIALS` (base64 service-account JSON,
  fail-fast when missing or non-decodable) BEFORE body
  parsing/validation; missing/invalid → `401 { error: 'authentication
  failed' }`, and the catalog/DB author comes from the verified claims via
  `authorFromProfile` (src/lib/profile.js) — the body `author` field is
  ignored. Simulate order: auth → validateBody → OWNERSHIP CHECK (existing
  sims row with a different author_uid and not admin → 403 BEFORE any
  bucket mutation) → resolveSumo → bucket delete (best-effort) + putObjects
  + putUploadRefs (review state untouched) → pack_run (422/504) →
  buildEntry → putReviewArtifacts (pack + stream) → finalizeSim → 200.
  Bucket failure at putReviewArtifacts → 500; the row stays pending +
  !sim_ready; a resubmit retries.
  Worker pool (`pool.js`, repo root): simulates and area exports run their
  subprocesses in bounded async slots (spawn, NOT spawnSync — the event
  loop stays free; the old promise-chain mutex is gone). `SIMO_WORKER_COUNT`
  slots (default cpus−1), `SIMO_WORKER_QUEUE_MAX` FIFO queue (default 32);
  a full queue → `503 { error: 'server busy — try again shortly' }`
  (`PoolBusyError`, `err.code === 'POOL_BUSY'`). Server close drains the
  pool; `opts.pool` / `opts.workerCount` / `opts.queueMax` are test seams
  (locked by test/pool.test.js + the endpoint concurrency case).
  `POST /api/export-net` (auth-first like simulate; NO db/bucket) —
  `{ bbox: [minLat,minLng,maxLat,maxLng], name?, zoom? }`: validateBbox →
  fetchOsm seam (default: OSM /api/0.6/map, simo-player UA, 60 s abort;
  OSM 400 → 400 smaller-box hint, 429/509 → 503 rate-limited, other → 502)
  → netconvert via `opts.netconvertResolver` (`findNetconvert`, same
  candidate list as findSumo; null → 500) in a pool slot with the retired
  convert.sh flags (incl. `--junctions.corner-detail 5`) and
  `SIMO_CONVERT_TIMEOUT_MS` (default 120 s → 504; nonzero → 422 stderr
  tail) → 200 `text/xml` attachment `<name>.net.xml` with
  `<!-- simo:zoom=N -->` on line 2. Tempdir removed on every path. Seams:
  `fetchOsm` / `netconvertResolver` / `convertTimeoutMs`
  (test/endpoint_export.test.js, fixture test/fixtures/mini.osm.xml).
  Review flow (Postgres + bucket; no filesystem writes): submissions stay
  `pending` until an admin activates them — the public catalog is the base
  bundle PLUS `GET /api/catalog` (active entry_json rows, replace-by-id in
  the client merge). Admin identity: SIMO_ADMIN_EMAILS (comma-separated,
  case-insensitive) vs the verified claims.email; unset → no admins
  (startup warning), an account without an email claim is never admin.
  Routes: `GET /api/me` (auth), `GET /api/catalog` (public), `GET
  /api/catalog/:id/stream` (public, active + bucket artifact), `GET
  /api/submissions` (admin all / user own), `GET /api/submissions/:id`
  (row + files + comments), `GET /api/submissions/:id/preview` (owner-or-
  admin → { entry, stream }; 404 when !sim_ready or no stream), `POST
  /api/submissions/:id/comments` (owner-or-admin; body trimmed non-empty
  ≤ 4 KB; is_admin stamped server-side), `POST .../activate {supersedes?}`
  (admin; requires sim_ready + entry_json + a stream artifact; pending/
  inactive → active; active without supersedes = idempotent 200; active
  with supersedes → 409; supersedes target must exist + be active + ≠ id;
  target flips to inactive with superseded_by in the SAME transaction —
  a non-active target rolls everything back), `POST .../reject {comment}`
  (admin, pending-only, comment required → 400), `POST
  .../deactivate` (admin, active-only). Bad input → 400, wrong state →
  409. `GET /api/files/:id` (name list, `[]` for unknown-but-valid ids)
  and `GET /api/files/:id/:name` (proxy download; 400 invalid id/name,
  404 missing) gate on ONE status lookup: no sims row or `status=active`
  → public (SimPanel keeps working unauthenticated); pending/rejected/
  inactive rows are owner-or-admin only (401 anon / 403 foreign) — that is
  also how the resubmit prefill re-downloads stored XMLs.
  Email notifications (`mailer.js`, plan: email-notifications): plain-text
  FIRE-AND-FORGET sends AFTER the response is written — a failed send logs
  one stdout line, never changes the API response (no retry/queue). Three
  triggers, recipients = the other party: comment posted (admin comment →
  `sims.author_email`; owner comment → all `SIMO_ADMIN_EMAILS`; the
  self-skip covers only the admin-commenting-own-sim direction; legacy
  rows skip), reject (owner, carries the rejection comment — the route's
  internal addComment never double-sends), activate WITH supersedes (the
  SUPERSEDED sim's owner only; plain/idempotent activation sends nothing).
  `opts.mailer` is the test seam (createMailerFromEnv fail-fast on missing
  `SIMO_SMTP_HOST/PORT/USER/PASS/FROM` — `SIMO_SMTP_URL` overrides
  HOST/PORT/USER/PASS wholesale, FROM always required; optional
  `SIMO_SMTP_SECURE` (465 default), `SIMO_PUBLIC_BASE_URL` appends a View
  link).
  pg/S3 handlers are async; heavy subprocess work is bounded by the worker
  pool above (review/catalog routes are pure async DB/bucket and need no
  pool). Startup constructs the DB pool + bucket client + mailer from env
  and fails fast listing missing vars; SIMO_ADMIN_EMAILS unset logs a
  warning.
  `test/endpoint.test.js` + `test/endpoint_review.test.js` run it with
  REAL SUMO (where the pipeline is exercised) against a temp player dir
  and the REAL `${PGDATABASE}_test` database; the bucket is an in-memory
  fake seam and failure cases inject `opts.db` / `opts.bucket` /
  `opts.verifyToken` / `opts.adminEmails`.
- `db.js` + `bucket.js` (repo root, NOT src/lib — src/lib must stay
  DOM-free) — upload persistence. Bytes live in an S3-compatible bucket
  (`bucket.js`: keys `uploads/<id>/<name>` built only from the fixed
  `FILE_NAMES` constants + an `ID_RE`-validated id; review artifacts at
  `uploads/<id>/review/{pack,stream}.json` via the same guard style —
  stream.json holds the payload OBJECT as JSON, not the JSONP wrapper;
  `createS3FromEnv` fail fast on `SIMO_S3_*`, `forcePathStyle` when
  `SIMO_S3_ENDPOINT` is set for MinIO; `createBucketFromEnv` dispatches to
  `bucket_disk.js` (a `{ bucket, send }` seam twin over a local directory
  under `SIMO_BUCKET_DISK_DIR` — dev storage, no SIMO_S3_* needed; wins
  over SIMO_S3_* when both set) when that var is set; the disk send
  re-guards keys and maps missing reads to `NoSuchKey`); Postgres holds refs + metadata
  only (`db.js`: `sims` row + `sim_files` rows — object key/url/size,
  never bytes; all queries parameterized; `putUploadRefs` is a single
  replace-on-resimulate transaction that touches metadata + author fields
  ONLY — never the review state; review API: `finalizeSim` (entry_json +
  sim_ready + review-state reset), `getSubmission`, `listSubmissions`
  (pending-first, comment_count), `listActiveEntries`, `listComments`/
  `addComment` (is_admin stamped by callers), `setStatus`,
  `activateTx` (activation + supersede in ONE tx with a non-active-target
  rollback guard)). `test/bucket.test.js` locks key guards + the
  `{ bucket, send }` client seam; `test/bucket_disk.test.js` locks the
  disk backend through the real bucket.js ops (refs shape, recursive
  delete, NoSuchKey, escape guards, env dispatch); `test/db_uploads.test.js` +
  `test/db_review.test.js` lock the DB API on real Postgres.
- `db/schema.sql` — idempotent DDL applied by `tools/db_setup.js` (npm run
  db:setup) and by the test harness (`test/helpers/pgTest.js`: requires
  all five PG* vars, creates `${PGDATABASE}_test` if missing, applies the
  schema). No migration framework — evolve the file in place: the
  pre-review schema is upgraded by ALTER TABLE IF NOT EXISTS columns +
  a `DO $$ … pg_constraint $$` block for the status CHECK (Postgres has
  no ADD CONSTRAINT IF NOT EXISTS); legacy rows backfill status='active',
  fresh rows default 'pending'.
- `test/` — vitest suites + `helpers/{streamPayload,dataConsts,pgTest}.js`;
  fixtures in `test/fixtures/` (sample.net.xml has the -1e10 sentinel
  origBoundary; mini.net.xml/mini.rou.xml are a real SUMO-runnable pair
  used by the endpoint suite). The DB suites need the five PG* vars set
  (copy `.env.example`); `vite.config.js` sets `fileParallelism: false` so
  the truncating db suite and the row-holding endpoint suite never share
  the test database concurrently.
- `design/` — standalone warm-redesign design sheet (`design-sheet.html`,
  opens via file://, no build, no app source involved) + generated imagery
  under `design/assets/`. The live theme is the Paper token block appended
  to `EXTRA_CSS` in `src/main.js` (theme swap point, locked by
  test/theme.test.js); the generated BALAGERE_CSS_STYLE stays untouched.

## Generated artifacts — do not hand-edit

- `public/data.js` — emitted by `../sim/build_player.py --export-mock
  public/data.js`. Format contract: every top-level definition is ONE line
  `const NAME = <valid JSON>;` (tests and dev_inject regex-parse it; the
  external generator's byte-stability depends on it).
- `public/streams/<id>.js` — single line
  `window.__simoStreamCallback('<id>',<JSON>);`. JSONP is deliberate;
  fetch() is not a drop-in (tests assert the format). Base-bundle entries
  only: review-flow entries stream via `GET /api/catalog/:id/stream`
  (payload JSON, no wrapper) instead.

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
