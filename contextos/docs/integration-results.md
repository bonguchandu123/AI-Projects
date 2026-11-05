# Odysseus integration — measured results

Date: 2026-11-05 · Odysseus image `ghcr.io/odysseus-dev/odysseus:latest` (v0.20.19, source identical to local checkout `9d0d3720` apart from line endings) · ContextOS backend on `127.0.0.1:4000`.

| Path | Status | What was actually verified |
|---|---|---|
| Docker → host connectivity | ✅ Works | From inside `odysseus-odysseus-1`, `http://host.docker.internal:4000/health` returned 200 with the backend bound to **127.0.0.1**. Docker Desktop forwards `host.docker.internal` to host loopback, so no LAN binding change was needed. |
| MCP: Odysseus client → ContextOS tools | ✅ Works (client level) | Odysseus's own `src/mcp_manager.McpManager` (run in its container via `integration-tests/odysseus/mcp_probe.py`) connected over **Streamable HTTP** (no OAuth prompt), discovered all **8 tools** as `mcp__<id>__<tool>`, and invoked `contextos_status`, `get_current_state`, `get_unverified_claims` with correct packets. |
| MCP: Odysseus **agent/LLM** choosing a tool | ⚠️ Not verified | Needs a configured chat model in Odysseus and the server registered in its UI. Steps below. |
| Webhook: Odysseus delivery code → ContextOS | ✅ Works (isolated) | Odysseus's real `WebhookManager._deliver` (same envelope, same HMAC-SHA256 `X-Odysseus-Signature`, same pinned HTTP transport) run in a throwaway process inside the container (`integration-tests/odysseus/webhook_probe.py`): **202** accepted → job worker → conversation stored and extracted; identical re-delivery → **200 duplicate**; wrong secret → **401**. |
| Webhook: live chat turn → ContextOS | ❌ Blocked locally (by design) | Odysseus rejects webhook URLs on private/loopback addresses (`localhost`, `127.0.0.1`, `host.docker.internal` all rejected — verified in the running container). No override exists. Works only with a publicly reachable ContextOS URL. The probe bypasses the URL check **only inside its own Python process**; Odysseus files, DB and server are untouched; no tunnel used. |
| Fallback | ✅ | Manual/paste ingestion in the dashboard (`/ingest`) and `POST /api/conversations`. |

## Reproduce

```powershell
# backend running (npm run start:backend), demo seeded (npm run demo:seed)
cd C:\Users\bongu\Downloads\AI-Projects\contextos
$env:MSYS_NO_PATHCONV = "1"
Get-Content integration-tests\odysseus\mcp_probe.py | docker exec -i -w /app odysseus-odysseus-1 python -
$secret = (Select-String -Path backend\.env -Pattern '^ODYSSEUS_WEBHOOK_SECRET=(.*)').Matches.Groups[1].Value
Get-Content integration-tests\odysseus\webhook_probe.py | docker exec -i -w /app -e CONTEXTOS_WEBHOOK_SECRET=$secret odysseus-odysseus-1 python -
```

Expected: `CONNECT {"ok": true, "status": "connected", "tool_count": 8 ...}` and `DELIVERY {"status": 202 ...}`, `REDELIVERY {"status": 200 ... "duplicate":true}`, `WRONG_SECRET {"status": 401}`.
A harmless `Error closing MCP server ctxprobe: Attempted to exit cancel scope...` is printed by Odysseus when the probe disconnects from a different asyncio task.

## Registering ContextOS in the live Odysseus (for the agent test)

1. Odysseus → Admin → MCP → Add server: name `ContextOS`, transport **http**, URL `http://host.docker.internal:4000/mcp`.
2. Ensure Odysseus has a working chat model; switch the chat to **agent** mode.
3. Ask: *"Use ContextOS to tell me what database StudyMate currently uses and why."*
4. The agent should call `get_current_state`; the result shows PostgreSQL (VERIFIED), the stated reason and the held MongoDB conflict.

For the webhook: Admin → Webhooks requires a public URL; with a public deployment use `https://<host>/api/webhooks/odysseus`, event `chat.completed`, and the same secret as `ODYSSEUS_WEBHOOK_SECRET`.
