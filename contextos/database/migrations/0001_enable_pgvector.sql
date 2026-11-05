-- 0001: enable pgvector.
-- Foundation only: the domain schema arrives in Phase 2 migrations.
-- Each migration file runs inside one transaction (see backend/src/db/migrate.ts).

CREATE EXTENSION IF NOT EXISTS vector;
