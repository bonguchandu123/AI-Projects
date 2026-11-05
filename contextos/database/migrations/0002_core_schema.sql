-- 0002: ContextOS core schema.
--
-- Layers:
--   1. Evidence (immutable): conversations, messages, memories (verbatim excerpts
--      extracted from messages, with provenance and embeddings).
--   2. Projection (deterministic, rebuildable from memories): subjects, decisions,
--      commitments, lifecycle_events, review_items. The lifecycle engine replays
--      memories in event-time order; the AI never writes this layer directly.
--   3. Integration: webhook_events, jobs.

-- ── Projects ────────────────────────────────────────────────────────────────
CREATE TABLE projects (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL CHECK (btrim(name) <> ''),
  description text        NOT NULL DEFAULT '',
  is_demo     boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_name_key ON projects (lower(name));

-- ── Conversations & messages (original evidence, never discarded) ──────────
CREATE TABLE conversations (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title             text        NOT NULL CHECK (btrim(title) <> ''),
  source            text        NOT NULL CHECK (source IN ('manual', 'paste', 'demo', 'odysseus_webhook', 'mcp')),
  external_ref      text,                               -- e.g. Odysseus session_id
  occurred_at       timestamptz NOT NULL,               -- event time: when the conversation happened
  recorded_at       timestamptz NOT NULL DEFAULT now(), -- record time: when ContextOS stored it
  is_demo           boolean     NOT NULL DEFAULT false,
  status            text        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  extraction_method text        CHECK (extraction_method IN ('gemini', 'fallback')),
  extraction_model  text,
  extraction_raw    jsonb,                              -- validated extractor output, kept for audit
  extraction_error  text,
  processed_at      timestamptz
);
CREATE INDEX conversations_project_time_idx ON conversations (project_id, occurred_at);

CREATE TABLE messages (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             integer NOT NULL CHECK (seq >= 0),
  role            text    NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'unknown')),
  speaker         text,
  content         text    NOT NULL,
  UNIQUE (conversation_id, seq)
);

-- ── Entities & relationships ───────────────────────────────────────────────
CREATE TABLE entities (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text        NOT NULL CHECK (btrim(name) <> ''),
  kind       text        NOT NULL DEFAULT 'other'
             CHECK (kind IN ('technology', 'component', 'person', 'organization', 'concept', 'other')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX entities_project_name_key ON entities (project_id, lower(name));

-- ── Decision subjects ("slots", e.g. StudyMate.database) ───────────────────
CREATE TABLE subjects (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  label       text        NOT NULL,
  cardinality text        NOT NULL DEFAULT 'exclusive' CHECK (cardinality IN ('exclusive', 'multi')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);

-- ── Decisions: one row per option within a subject (projection) ────────────
-- Two independent lifecycle axes: commitment_status and implementation_status.
CREATE TABLE decisions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_id            uuid        NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  entity_id             uuid        REFERENCES entities(id) ON DELETE SET NULL,
  option_key            text        NOT NULL,
  option_name           text        NOT NULL,
  title                 text        NOT NULL,
  reason                text,
  commitment_status     text        NOT NULL DEFAULT 'NONE'
                        CHECK (commitment_status IN ('NONE', 'PROPOSED', 'DECIDED', 'REJECTED', 'CANCELLED', 'REVERSED', 'SUPERSEDED')),
  implementation_status text        NOT NULL DEFAULT 'NOT_STARTED'
                        CHECK (implementation_status IN ('NOT_STARTED', 'CLAIMED_IMPLEMENTED', 'VERIFIED', 'RETIRED')),
  is_disputed           boolean     NOT NULL DEFAULT false,
  superseded_by         uuid        REFERENCES decisions(id) ON DELETE SET NULL,
  first_seen_at         timestamptz NOT NULL,
  proposed_at           timestamptz,
  decided_at            timestamptz,
  implemented_at        timestamptz,
  verified_at           timestamptz,
  closed_at             timestamptz,  -- rejected / cancelled / reversed / superseded
  retired_at            timestamptz,
  is_active             boolean     NOT NULL DEFAULT true, -- false when no memory references it after a rebuild
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, option_key)
);
CREATE INDEX decisions_project_idx ON decisions (project_id, commitment_status, implementation_status);

-- ── Commitments (action items with their own lifecycle) ────────────────────
CREATE TABLE commitments (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title_key   text        NOT NULL,
  title       text        NOT NULL,
  owner       text,
  due_at      timestamptz,
  status      text        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'CANCELLED')),
  opened_at   timestamptz NOT NULL,
  closed_at   timestamptz,
  is_active   boolean     NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, title_key)
);

-- ── Memories: verbatim, source-linked extractions (the evidence layer) ─────
CREATE TABLE memories (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id   uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id        uuid        REFERENCES messages(id) ON DELETE SET NULL,
  item_index        integer     NOT NULL,           -- order within the conversation's extraction
  kind              text        NOT NULL CHECK (kind IN (
                      'fact', 'proposal', 'decision', 'rejection', 'cancellation', 'reversal',
                      'in_use', 'implementation_claim', 'verification',
                      'commitment', 'commitment_done', 'commitment_cancelled')),
  summary           text        NOT NULL,
  excerpt           text        NOT NULL,           -- verbatim quote from the source message
  excerpt_verified  boolean     NOT NULL,           -- excerpt was found in the stored source text
  subject_key       text,
  subject_label     text,
  option_name       text,
  previous_option   text,
  replaces_previous boolean     NOT NULL DEFAULT false,
  reason            text,
  commitment_title  text,
  commitment_owner  text,
  commitment_due_at timestamptz,
  speaker_role      text        NOT NULL DEFAULT 'unknown',
  hedged            boolean     NOT NULL DEFAULT false,
  confidence        real        NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  extraction_method text        NOT NULL CHECK (extraction_method IN ('gemini', 'fallback')),
  is_demo           boolean     NOT NULL DEFAULT false,
  decision_id       uuid        REFERENCES decisions(id) ON DELETE SET NULL,
  commitment_id     uuid        REFERENCES commitments(id) ON DELETE SET NULL,
  embedding         vector(768),
  search_tsv        tsvector GENERATED ALWAYS AS (
                      to_tsvector('english',
                        summary || ' ' || excerpt || ' ' || coalesce(option_name, '') || ' ' ||
                        coalesce(subject_label, '') || ' ' || coalesce(reason, '') || ' ' ||
                        coalesce(commitment_title, ''))
                    ) STORED,
  UNIQUE (conversation_id, item_index)
);
CREATE INDEX memories_project_time_idx ON memories (project_id, occurred_at);
CREATE INDEX memories_decision_idx ON memories (decision_id);
CREATE INDEX memories_tsv_idx ON memories USING gin (search_tsv);
CREATE INDEX memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops);

CREATE TABLE relationships (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_entity_id uuid        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id uuid        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate        text        NOT NULL,
  memory_id        uuid        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_entity_id, target_entity_id, predicate)
);

-- ── Lifecycle events (append-only history of the projection) ───────────────
-- Every event references the memory (evidence) that caused it.
CREATE TABLE lifecycle_events (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision_id         uuid        REFERENCES decisions(id) ON DELETE CASCADE,
  commitment_id       uuid        REFERENCES commitments(id) ON DELETE CASCADE,
  seq                 integer     NOT NULL,          -- replay order within the project
  event_type          text        NOT NULL CHECK (event_type IN (
                        'PROPOSED', 'DECIDED', 'REJECTED', 'CANCELLED', 'REVERSED', 'SUPERSEDED',
                        'IMPLEMENTATION_CLAIMED', 'VERIFIED', 'RETIRED',
                        'CORROBORATED', 'CONFLICT_FLAGGED', 'HELD_FOR_REVIEW',
                        'COMMITMENT_OPENED', 'COMMITMENT_DONE', 'COMMITMENT_CANCELLED')),
  applied             boolean     NOT NULL,          -- false: held for review, state unchanged
  from_commitment     text,
  to_commitment       text,
  from_implementation text,
  to_implementation   text,
  memory_id           uuid        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  occurred_at         timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  actor               text        NOT NULL CHECK (actor IN ('extraction', 'engine', 'reviewer')),
  note                text,
  CHECK (decision_id IS NOT NULL OR commitment_id IS NOT NULL)
);
CREATE INDEX lifecycle_events_decision_idx ON lifecycle_events (decision_id, seq);
CREATE INDEX lifecycle_events_project_idx ON lifecycle_events (project_id, seq);
CREATE INDEX lifecycle_events_commitment_idx ON lifecycle_events (commitment_id);

-- ── Review queue ───────────────────────────────────────────────────────────
-- Keyed by (memory_id, kind) so reviewer resolutions survive projection rebuilds.
CREATE TABLE review_items (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_id       uuid        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  decision_id     uuid        REFERENCES decisions(id) ON DELETE SET NULL,
  commitment_id   uuid        REFERENCES commitments(id) ON DELETE SET NULL,
  kind            text        NOT NULL CHECK (kind IN (
                    'conflict', 'ambiguous', 'missing_decision', 'unverified_excerpt', 'reopened')),
  status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
  is_active       boolean     NOT NULL DEFAULT true,
  blocking        boolean     NOT NULL,              -- true: the transition was held back
  title           text        NOT NULL,
  detail          text        NOT NULL,
  proposed        jsonb,                             -- the held transition, for display
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolution_note text,
  UNIQUE (memory_id, kind)
);
CREATE INDEX review_items_status_idx ON review_items (status, created_at);

-- ── Odysseus webhook deliveries ────────────────────────────────────────────
CREATE TABLE webhook_events (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text        NOT NULL DEFAULT 'odysseus',
  event_type       text        NOT NULL,
  dedupe_key       text        NOT NULL UNIQUE,      -- sha256 of event + data (excludes delivery timestamp)
  signature_status text        NOT NULL CHECK (signature_status IN ('valid', 'not_configured')),
  payload          jsonb       NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  status           text        NOT NULL CHECK (status IN ('accepted', 'ignored', 'processed', 'failed')),
  conversation_id  uuid        REFERENCES conversations(id) ON DELETE SET NULL,
  error            text
);

-- ── Background jobs (Postgres-backed queue, no Redis) ──────────────────────
CREATE TABLE jobs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text        NOT NULL CHECK (kind IN ('process_conversation')),
  payload     jsonb       NOT NULL,
  status      text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts    integer     NOT NULL DEFAULT 0,
  last_error  text,
  run_after   timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_queue_idx ON jobs (status, run_after) WHERE status = 'queued';
