-- simo-player Postgres schema — system of record for wizard submissions:
-- sim metadata (sims) + references to the bucket objects holding the
-- uploaded XMLs (sim_files: object key + url + size, never the bytes).
-- Idempotent: applied by tools/db_setup.js (and by the test harnesses) in
-- a transaction; no migration framework — evolve in place.
--
-- The CHECK on sims.id mirrors server.js validateBody's ID_RE at the DB
-- layer (defense in depth — app-level validation happens first, exactly
-- like the pre-path.join checks of the retired fs storage).
-- Replace-on-resimulate is an app-level transaction (db.js putUploadRefs):
-- upsert the sims row + delete this sim's sim_files rows + insert new refs.

CREATE TABLE IF NOT EXISTS sims (
  id          TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]*$'),
  title       TEXT NOT NULL,
  author      TEXT,
  description TEXT,
  anchor_lat  DOUBLE PRECISION,
  anchor_lng  DOUBLE PRECISION,
  rotation    DOUBLE PRECISION,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sim_files (
  sim_id     TEXT     NOT NULL REFERENCES sims(id) ON DELETE CASCADE,
  name       TEXT     NOT NULL CHECK (name IN
                        ('today.net.xml', 'demand.rou.xml', 'proposed.net.xml')),
  object_key TEXT     NOT NULL,
  object_url TEXT     NOT NULL,
  size_bytes BIGINT   NOT NULL CHECK (size_bytes >= 0),
  PRIMARY KEY (sim_id, name)
);