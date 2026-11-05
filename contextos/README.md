# ContextOS

**Decision-aware memory intelligence for AI workspaces.** ContextOS tracks how project decisions evolve, from proposal to decision to implementation to verification, and answers "what is true now, why, and where's the evidence?". Answers come from a deterministic lifecycle engine, not from similarity search.

- Design: [docs/01-foundation-parts-A-D.md](docs/01-foundation-parts-A-D.md)
- Architecture decisions: [docs/decisions.md](docs/decisions.md)
- Odysseus integration results: [docs/integration-results.md](docs/integration-results.md)
- Demo script: [docs/demo-script.md](docs/demo-script.md)

## Layout

| Path | What it is |
|---|---|
| `backend/` | Fastify modular monolith. It contains ingestion, extraction (Gemini or the labelled fallback), the lifecycle engine, read models, the query engine, the REST API, the Odysseus webhook, the Postgres job worker, and the MCP endpoint. Data access is raw SQL via `pg`. |
| `mcp-server/` | The MCP tool contract: 8 read-only tools, mounted by the backend at `POST /mcp`. |
| `frontend/` | Next.js 16 dashboard (Tailwind 4, shadcn/ui, React Flow, Recharts). It calls the backend only through its own server-side proxy. |
| `database/` | `docker-compose.yml` (PostgreSQL 18 + pgvector 0.8.3 on port **5433**) and SQL migrations. |
| `integration-tests/` | Odysseus probes: a webhook receiver, `odysseus/mcp_probe.py` and `odysseus/webhook_probe.py`. This folder is not part of the workspace. |

## Prerequisites

Node ≥ 22.12, npm ≥ 10, Docker Desktop. Gemini is optional.

## First-time setup

```powershell
cd contextos
npm install
Copy-Item backend\.env.example backend\.env          # then set ODYSSEUS_WEBHOOK_SECRET; optionally GEMINI_API_KEY
Copy-Item frontend\.env.example frontend\.env.local
npm run db:up        # Postgres + pgvector, waits until healthy
npm run db:migrate   # applies database/migrations/*.sql
npm run demo:seed    # imports the synthetic StudyMate dataset (labelled demo data)
```

## Run the application

```powershell
# terminal 1
npm run start:backend      # http://127.0.0.1:4000   (/health/ready, /api/*, POST /mcp, POST /api/webhooks/odysseus)
# terminal 2
npm run build              # once, or after frontend changes
npm run start:frontend     # http://localhost:3000
```

For development with auto-reload, use `npm run dev:backend` and `npm run dev:frontend` instead.

## Gemini

Set `GEMINI_API_KEY` in `backend/.env` and restart the backend. The defaults are `GEMINI_MODEL=gemini-3.1-flash-lite` and `GEMINI_EMBEDDING_MODEL=gemini-embedding-001` (768 dimensions).

Without a key, every extraction uses the deterministic fallback extractor. The UI and API label each extraction as "Fallback extractor"; ContextOS never claims Gemini processed a conversation it didn't. If Gemini errors, the fallback is used and the error is recorded on the conversation.

## Checks

```powershell
npm run typecheck   # all workspaces
npm run lint        # backend + mcp-server (typed) and frontend
npm test            # 70 backend tests against real Docker Postgres (db:up first)
npm run build       # frontend production build
npm run db:status
```

## API (summary)

| Area | Endpoints |
|---|---|
| Projects | `GET/POST /api/projects`, `GET/PATCH /api/projects/:id` |
| Conversations | `GET/POST /api/conversations`, `GET /api/conversations/:id`, `POST /api/conversations/:id/process`, `POST /api/demo/import` |
| Decisions | `GET /api/decisions`, `GET /api/decisions/:id`, `.../history`, `.../evidence`, `GET /api/commitments` |
| Memory | `POST /api/memory/query`, `GET /api/memory/search`, `GET /api/memory/current-state/:projectId`, `GET /api/memory/timeline[/:projectId]`, `GET /api/memory/graph/:projectId` |
| Review | `GET /api/reviews`, `POST /api/reviews/:id/resolve` (`confirm` or `dismiss`) |
| Integration | `POST /api/webhooks/odysseus`, `GET /api/settings/status`, `POST /mcp` |

## Security notes (hackathon MVP)

- There is no user authentication, by design. The backend binds to `127.0.0.1` only.
- `/mcp` enforces a Host-header allowlist to protect against DNS rebinding. The webhook requires an HMAC signature when `ODYSSEUS_WEBHOOK_SECRET` is set.
- All SQL is parameterised. All inputs and all model outputs are validated with Zod.
- Secrets are never returned by the API or shown in the UI.
- Not implemented yet: rate limiting, and a secret path segment on `/mcp`. Both are needed before exposing ContextOS beyond localhost.
