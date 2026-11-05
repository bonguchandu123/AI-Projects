# Architecture Decision Log

Short records of decisions that shape the codebase. Newest last. Each entry: context → decision → consequences.

---

## ADR-001 — npm workspaces monorepo (Phase 1, 2026-11-05)

**Context.** Four code areas (frontend, backend, mcp-server, database) must stay clearly separated but share TypeScript settings and run locally with minimal tooling. pnpm is not installed; npm 11 is.

**Decision.** One repo, npm workspaces: `mcp-server`, `backend`, `frontend`. `database/` holds SQL + Docker config only (not a package). `integration-tests/` is **not** a workspace: it keeps its own lockfile and toolchain (it uses TypeScript 7) so the Phase 1 probes stay untouched.

**Consequences.** One `npm install` at the root. Shared `tsconfig.base.json`. Workspace packages are consumed as TypeScript source (no build step) and run with `tsx`. A compile step is needed before any deployment (deferred: hackathon runs locally).

## ADR-002 — TypeScript 6.0.x, ESLint 9 (Phase 1)

**Context.** Latest TypeScript is 7.0.2, but its npm package no longer exposes the classic compiler API, and `typescript-eslint@8.72` declares `typescript >=4.8.4 <6.1.0`. `eslint-plugin-react` (used by `eslint-config-next`) declares `eslint ^9.7` at most; ESLint 10 is out.

**Decision.** Pin `typescript ~6.0.3` and `eslint ^9.39.5` across the workspace.

**Consequences.** Typed linting works for backend, mcp-server and frontend. npm prints a "no longer supported" notice for ESLint 9; revisit when `eslint-plugin-react` supports ESLint 10 and typescript-eslint supports TS 7.

## ADR-003 — MCP package mounted inside the backend (Phase 1)

**Context.** The agreed architecture (foundation doc D.2/D.7) is a modular monolith with the MCP server mounted in Fastify over Streamable HTTP. The requested layout has a separate `mcp-server/` folder.

**Decision.** `@contextos/mcp-server` owns only the MCP contract (tool names, schemas, descriptions). It has no database access; the backend injects capabilities through the `ContextosMcpDeps` interface and mounts it at `POST /mcp` using the SDK's stateless Streamable HTTP pattern (new server + transport per request). GET/DELETE return 405.

**Consequences.** One process, one connection pool, no service-to-service HTTP. MCP schemas live in one place. `/mcp` is protected by a Host-header allowlist (DNS-rebinding protection, mirroring the SDK's `hostHeaderValidation`). The secret path segment `/mcp/:key` (foundation doc D.7) is **not** implemented yet; it is Phase 7 work.

## ADR-004 — Custom forward-only SQL migration runner (Phase 1)

**Context.** No ORM is allowed; the foundation doc left "node-pg-migrate SQL mode vs small custom runner" open.

**Decision.** ~150-line runner in `backend/src/db/migrate.ts`: files `database/migrations/NNNN_name.sql`, one transaction per file (DDL + bookkeeping row together), `pg_advisory_lock` against concurrent runs, SHA-256 checksums with CRLF→LF normalisation (Windows checkouts), refusal to run if an applied file was edited/removed or a new file is older than the latest applied.

**Consequences.** Zero third-party migration dependency; behaviour is tested against real Postgres. Forward-only (no down migrations): fixes are new migrations. Statements that cannot run in a transaction (e.g. `CREATE INDEX CONCURRENTLY`) are unsupported until needed.

## ADR-005 — Local Postgres on host port 5433, pgvector 0.8.3 / PostgreSQL 18 (Phase 1)

**Context.** A native Windows PostgreSQL service (`postgres.exe`) already listens on 5432.

**Decision.** `pgvector/pgvector:0.8.3-pg18` (pinned tag) via `database/docker-compose.yml`, bound to `127.0.0.1:5433`. The volume is mounted at `/var/lib/postgresql` (PostgreSQL 18 image layout).

**Consequences.** No clash with the native service. Dev credentials are local-only and live in `.env.example`.

## ADR-006 — Health model (Phase 1)

**Decision.** `GET /health` = liveness (never touches the DB). `GET /health/ready` = DB reachable + pgvector installed + zero pending migrations + no migration problems; 503 with details otherwise. One function (`getSystemStatus`) backs both the readiness route and the MCP `contextos_status` tool. The backend starts even when the DB is not ready, and logs a warning. The frontend's `/api/health` returns 200 only when the whole chain is ready.

## ADR-007 — Frontend talks to the backend server-side only (Phase 1)

**Decision.** `CONTEXTOS_API_URL` has no `NEXT_PUBLIC_` prefix; all backend calls go through `src/lib/backend.ts` (`import "server-only"`). With Cache Components on (Next 16 default), live data is rendered inside `<Suspense>` after `connection()`, so builds never call the backend.

**Consequences.** No CORS configuration needed; a future backend API key stays on the server.

## ADR-008 — Local-only for the hackathon (Phase 1)

**Context.** The foundation doc assumed Vercel/Render deployment; current instructions are to run everything locally.

**Decision.** No deployment configuration. Consequences for later phases:
- Odysseus (Docker) reaches ContextOS via `host.docker.internal`.
- **Odysseus webhooks cannot target private/loopback addresses** (verified in the running container). Real chat-triggered webhook delivery to a local ContextOS needs either a tunnel or a test-only workaround; see the Phase 1 integration-test notes. Must be resolved before Phase 3 end-to-end tests.

## ADR-009 — Memories are evidence; decisions are a rebuildable projection (MVP)

**Decision.** Extracted `memories` (verbatim excerpt + message + conversation + extraction method) are the immutable evidence layer. `decisions`, `commitments`, `lifecycle_events` and `review_items` are a projection produced by replaying all of a project's memories, in event-time order, through the pure lifecycle engine (`backend/src/domain/lifecycle.ts`). Rebuilds run in one transaction under a project row lock; decision ids are stable (upsert by subject + option); reviewer resolutions are inputs to the replay.

**Consequences.** Late-arriving or re-processed conversations produce the correct state; every lifecycle event has a `memory_id NOT NULL` (evidence enforced by the schema); Gemini never writes state. Proposals are not a separate table: a proposal and a decision of the same option are the same record at different commitment levels. `SUPERSEDED` was added to the commitment axis so replaced options remain visible history.

## ADR-010 — Excerpt verification gate

Every extractor excerpt is matched (whitespace/quote-normalised) against the stored message text. Unmatched excerpts are stored with `excerpt_verified=false` and their transitions are held for review (`unverified_excerpt`). This is what prevents an LLM from fabricating evidence.

## ADR-011 — Deterministic answers, optional Gemini narrative

`POST /api/memory/query` interprets questions with deterministic rules and composes the direct answer from projection state, with evidence ids E1..En. If Gemini is configured, a narrative is generated from that packet only; citations not in the packet are stripped. MCP tools return context packets, never generated answers.

## ADR-012 — Odysseus webhook ingestion

`POST /api/webhooks/odysseus`: HMAC over the raw body (constant-time compare), ±15 min timestamp window, dedupe on sha256(event + data) excluding the delivery timestamp, fast 202, processing via the Postgres job queue (`jobs`, `FOR UPDATE SKIP LOCKED`, 3 attempts with backoff). Conversations route to a project named in the user message, else `ODYSSEUS_DEFAULT_PROJECT`. Bad signatures are rejected without storing anything.

## ADR-013 — Offline-capable frontend; same-origin proxy

System font stack instead of `next/font/google` (no network at build/dev). All browser calls go through `/api/cos/*`, a Next route handler that forwards to the backend server-side. The client shell is wrapped in `<Suspense>` (required by Cache Components for URL-reading hooks on dynamic routes).

## ADR-014 — Windows native binding pin

`npm install --workspace …` dropped rolldown's Windows binding (npm optional-dependency bug), breaking Vitest. `@rolldown/binding-win32-x64-msvc` is pinned as a root optional dependency (skipped automatically on other platforms).
