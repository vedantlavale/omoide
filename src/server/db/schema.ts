/**
 * The whole data model, in one place. Kept as a TS string so it is bundled with
 * the server (no runtime file reads) and applied idempotently on first connect.
 * The same DDL runs on embedded PGlite and on a real Postgres.
 */
export const SCHEMA_SQL = `
-- Omoide schema. Plain SQL on purpose: it is the same file against PGlite and a
-- real Postgres, and a reviewer can read the whole data model in one screen.

CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,
  timezone    text NOT NULL DEFAULT 'UTC',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS threads (
  id          text PRIMARY KEY,
  user_id     text NOT NULL,
  title       text,
  summary     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  is_demo     boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS messages (
  id          text PRIMARY KEY,
  thread_id   text NOT NULL,
  user_id     text NOT NULL,
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- The user's local calendar date at write time: makes "what did I ask on
  -- 3 November" an indexed equality lookup instead of a UTC range scan.
  local_date  text NOT NULL,
  tz          text NOT NULL DEFAULT 'UTC',
  turn_id     text,
  plan        jsonb,
  sources     jsonb,
  embedding   jsonb,
  is_demo     boolean NOT NULL DEFAULT false,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

CREATE TABLE IF NOT EXISTS sources (
  canonical_url  text PRIMARY KEY,
  url            text NOT NULL,
  title          text,
  site           text,
  published_at   text,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_fetched_at timestamptz,
  content_hash   text,
  etag           text,
  last_modified  text,
  snapshot       text
);

CREATE TABLE IF NOT EXISTS claims (
  id          text PRIMARY KEY,
  user_id     text NOT NULL,
  message_id  text NOT NULL,
  thread_id   text NOT NULL,
  entity      text NOT NULL,
  attribute   text NOT NULL,
  value       text NOT NULL,
  unit        text,
  qualifier   text,
  quote       text NOT NULL,
  source_url  text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  -- Event time: when the fact became true in the world (the source page's
  -- publish date, or what the page itself states). Distinct from observed_at,
  -- which is when WE learned it — old news must not look like current reality.
  event_at    text,
  local_date  text NOT NULL,
  embedding   jsonb,
  is_demo     boolean NOT NULL DEFAULT false,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', entity || ' ' || attribute || ' ' || value)) STORED
);

CREATE TABLE IF NOT EXISTS claim_checks (
  id             text PRIMARY KEY,
  claim_id       text NOT NULL,
  checked_at     timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL,
  new_value      text,
  evidence_url   text,
  method         text,
  note           text
);

CREATE TABLE IF NOT EXISTS search_cache (
  key         text PRIMARY KEY,
  provider    text NOT NULL,
  response    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
  id          text PRIMARY KEY,
  message_id  text,
  thread_id   text,
  data        jsonb NOT NULL,
  total_ms    integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_user_date_idx ON messages (user_id, local_date);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS messages_tsv_idx ON messages USING GIN (tsv);
CREATE INDEX IF NOT EXISTS claims_user_entity_idx ON claims (user_id, entity);
CREATE INDEX IF NOT EXISTS claims_message_idx ON claims (message_id);
CREATE INDEX IF NOT EXISTS claims_tsv_idx ON claims USING GIN (tsv);
-- Migration for databases created before event_at existed (both PGlite and
-- hosted Neon run this file on every connect; IF NOT EXISTS makes it a no-op
-- on fresh schemas).
ALTER TABLE claims ADD COLUMN IF NOT EXISTS event_at text;
CREATE INDEX IF NOT EXISTS threads_user_idx ON threads (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS traces_message_idx ON traces (message_id);
CREATE INDEX IF NOT EXISTS search_cache_expiry_idx ON search_cache (expires_at);

INSERT INTO users (id, timezone) VALUES ('local', 'UTC')
ON CONFLICT (id) DO NOTHING;
`;
