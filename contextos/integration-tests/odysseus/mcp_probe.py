"""
Phase-1 integration probe: drive Odysseus's OWN MCP client (src/mcp_manager.McpManager)
against the ContextOS MCP endpoint, from inside the running Odysseus container.

Proves: Docker->host connectivity, Streamable HTTP transport compatibility,
tool discovery, and a real tool invocation through Odysseus's client code.
Does NOT prove: that the Odysseus *agent/LLM* chooses to call the tool (that
needs a configured chat model; see docs/integration-results.md).

Run (no Odysseus files are modified; the script is piped over stdin):
  docker exec -i -w /app odysseus-odysseus-1 python - < integration-tests/odysseus/mcp_probe.py
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, "/app")
URL = os.environ.get("CONTEXTOS_MCP_URL", "http://host.docker.internal:4000/mcp")


async def main() -> int:
    from src.mcp_manager import McpManager

    m = McpManager()
    ok = await m.connect_server(server_id="ctxprobe", name="ContextOS (probe)", transport="http", url=URL)
    status = m.get_server_status("ctxprobe")
    print("CONNECT", json.dumps({"ok": ok, "status": status.get("status"), "tool_count": status.get("tool_count"), "error": status.get("error")}))
    if not ok:
        return 1
    tools = [t["qualified_name"] for t in m.get_all_tools() if t["server_id"] == "ctxprobe"]
    print("TOOLS", json.dumps(tools))

    for name, args in [
        ("contextos_status", {}),
        ("get_current_state", {"project": "StudyMate", "subject": "database"}),
        ("get_unverified_claims", {"project": "StudyMate"}),
    ]:
        r = await m.call_tool(f"mcp__ctxprobe__{name}", args)
        text = json.dumps(r)
        print("CALL", name, "->", text[:900] + ("..." if len(text) > 900 else ""))

    await m.disconnect_server("ctxprobe")
    return 0


sys.exit(asyncio.run(main()))
