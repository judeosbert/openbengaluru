-- simo-player Postgres schema — system of record for wizard submissions:
-- sim metadata (sims) + references to the bucket objects holding the
-- uploaded XMLs (sim_files: object key + url + size, never the bytes) and
-- the review workflow state (status transitions + comment thread).
-- Idempotent: applied by tools/db_setup.js (and by the test harnesses) in
-- a transaction; no migration framework — evolve in place.
--
-- The CHECK on sims.id mirrors server.js validateBody's ID_RE at the DB
-- layer (defense in depth — app-level validation happens first, exactly
-- like the pre-path.join checks of the retired fs storage).
-- Replace-on-resimulate is an app-level transaction (db.js putUploadRefs):
-- upsert the sims row + delete this sim's sim_files rows + insert new refs.
-- The on-conflict update deliberately touches ONLY metadata + file refs +
-- author fields — never the review state (status/sim_ready/entry_json): a
-- failed re-pipeline changes nothing but the stored sources.
--
-- Review workflow columns (plan: review flow + dashboards):
--   status         pending -> active | rejected; active -> inactive
--                  (superseded or pulled); re-activation of inactive ok.
--   author_uid     Firebase uid — the ownership key (author is display text)
--   sim_ready      true only after a successful pipeline (entry_json set);
--                  pending + !sim_ready = "simulation failed, resubmit"
--   entry_json     the catalog entry object (buildEntry output), served by
--                  GET /api/catalog when status='active'
--   demand / peak_served / has_proposed   dashboard list-row columns
--   reviewed_by/at  admin identity + time of the last review action
--   superseded_by  on an inactive row: which entry superseded this one
--
-- Legacy rows created before this evolution backfilled status='active'
-- (they were live in the catalog); new submissions default 'pending'.

CREATE TABLE IF NOT EXISTS sims (
  id          TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]*$'),
  title       TEXT NOT NULL,
  author      TEXT,
  description TEXT,
  data_source TEXT
              CONSTRAINT sims_data_source_check
              CHECK (data_source IN
                ('manual_survey', 'survey_data', 'approximation')),
  source_url  TEXT,
  anchor_lat  DOUBLE PRECISION,
  anchor_lng  DOUBLE PRECISION,
  rotation    DOUBLE PRECISION,
  status      TEXT NOT NULL DEFAULT 'pending'
              CONSTRAINT sims_status_check
              CHECK (status IN ('pending', 'active', 'rejected', 'inactive')),
  author_uid  TEXT,
  author_email TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  superseded_by TEXT,
  demand      INTEGER,
  peak_served INTEGER,
  has_proposed BOOLEAN NOT NULL DEFAULT false,
  sim_ready   BOOLEAN NOT NULL DEFAULT false,
  entry_json  JSONB,
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

CREATE TABLE IF NOT EXISTS review_comments (
  id         BIGSERIAL PRIMARY KEY,
  sim_id     TEXT     NOT NULL REFERENCES sims(id) ON DELETE CASCADE,
  author     TEXT     NOT NULL,
  author_uid TEXT     NOT NULL,
  is_admin   BOOLEAN  NOT NULL DEFAULT false,
  body       TEXT     NOT NULL CHECK (length(trim(body)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Captures (plan: capture-leaderboard page): commuter field-data uploads —
-- ONE ROW = ONE ACCEPTED CAPTURE = 1 leaderboard point (no review flow;
-- admin moderation is a HARD delete — the reject route removes the bucket
-- object + this row (bucket first, retryable; a later DB failure orphans
-- the object, accepted) and the count(*) leaderboard self-heals; the
-- reason lives in the uploader email, never in a table). Bytes live in the
-- bucket under captures/<id>/<name> (bucket.js captureKey — deliberately
-- NEVER uploads/<id>/, a simulate resubmit's deleteObjects prefix-delete
-- must not touch them); this table holds attribution + references, never
-- bytes.
--   id           server-generated before the bucket put (the object name
--                embeds it: <capture-id>_<junction-slug>.<ext>)
--   author_*     Firebase uid + authorFromProfile display name + email
--   content_hash SHA-256 hex recomputed server-side over the buffered
--                bytes — the per-author duplicate key (unique index)
--   geo_lat/lng  nullable, stored RAW (no validation — verification means
--                a reviewer can inspect the coordinates later)
CREATE TABLE IF NOT EXISTS captures (
  id           TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]*$'),
  author_uid   TEXT NOT NULL,
  author_name  TEXT NOT NULL,
  author_email TEXT,
  junction     TEXT NOT NULL CHECK (length(trim(junction)) > 0),
  method       TEXT NOT NULL
               CONSTRAINT captures_method_check
               CHECK (method IN
                 ('snapshot', 'footbridge', 'stopwatch', 'other')),
  captured_at  TIMESTAMPTZ,
  content_hash TEXT NOT NULL,
  object_key   TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size    BIGINT NOT NULL CHECK (byte_size >= 0),
  geo_lat      DOUBLE PRECISION,
  geo_lng      DOUBLE PRECISION,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------- evolution
-- Upgrade path for databases created with the pre-review schema: add the
-- new columns (existing rows are live today -> backfill status='active'),
-- flip the default to 'pending' for fresh rows, then guard-add the status
-- CHECK (Postgres has no ADD CONSTRAINT IF NOT EXISTS).

ALTER TABLE sims ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE sims ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE sims ADD COLUMN IF NOT EXISTS author_uid TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS author_email TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS superseded_by TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS demand INTEGER;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS peak_served INTEGER;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS has_proposed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS sim_ready BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS entry_json JSONB;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS data_source TEXT;
ALTER TABLE sims ADD COLUMN IF NOT EXISTS source_url TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sims_status_check' AND conrelid = 'sims'::regclass
  ) THEN
    ALTER TABLE sims ADD CONSTRAINT sims_status_check
      CHECK (status IN ('pending', 'active', 'rejected', 'inactive'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sims_data_source_check' AND conrelid = 'sims'::regclass
  ) THEN
    ALTER TABLE sims ADD CONSTRAINT sims_data_source_check
      CHECK (data_source IN
        ('manual_survey', 'survey_data', 'approximation'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sims_author_uid_idx ON sims (author_uid);
CREATE INDEX IF NOT EXISTS sims_status_idx ON sims (status);
CREATE INDEX IF NOT EXISTS review_comments_sim_id_idx
  ON review_comments (sim_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS captures_author_hash_idx
  ON captures (author_uid, content_hash);