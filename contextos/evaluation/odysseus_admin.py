"""
Evaluation helper executed INSIDE the Odysseus container with Odysseus's own modules.
Piped over stdin; no Odysseus files are modified.

  docker exec -i -w /app odysseus-odysseus-1 python - <command> [args...] < evaluation/odysseus_admin.py

Commands (all print one JSON line):
  mcp-register <name> <url>        create the MCP server row if missing (Odysseus connects it on startup)
  mcp-tools <server_id> on|off     enable/disable all of its tools (read by Odysseus on every agent turn)
  mcp-remove <server_id>           delete the MCP server row
  mem-add <owner> <base64-json>    add labelled baseline memories via Odysseus's native memory provider
  mem-cleanup <owner>              delete every memory added by this evaluation (source=contextos_eval)
  session-tokens <id> [<id>...]    Odysseus's own per-session token/cost counters
"""
import asyncio
import base64
import json
import sys

sys.path.insert(0, "/app")
CONTEXTOS_TOOLS = [
    "contextos_status", "get_current_state", "get_decision_history", "get_decision_evidence",
    "get_pending_commitments", "get_unverified_claims", "search_memory", "get_project_summary",
]
EVAL_SOURCE = "contextos_eval"


def out(obj):
    print(json.dumps(obj, default=str))


def db():
    from core.database import SessionLocal
    return SessionLocal()


def mcp_register(name, url):
    import uuid
    from core.database import McpServer
    s = db()
    try:
        existing = s.query(McpServer).filter(McpServer.url == url).first()
        if existing:
            return out({"id": existing.id, "created": False})
        sid = str(uuid.uuid4())[:8]
        s.add(McpServer(id=sid, name=name, transport="http", url=url, args="[]", env="{}", is_enabled=True))
        s.commit()
        out({"id": sid, "created": True})
    finally:
        s.close()


def mcp_tools(server_id, state):
    from core.database import McpServer
    s = db()
    try:
        srv = s.query(McpServer).filter(McpServer.id == server_id).first()
        if not srv:
            return out({"error": "server not found"})
        srv.disabled_tools = json.dumps([] if state == "on" else CONTEXTOS_TOOLS)
        s.commit()
        out({"id": server_id, "tools": state})
    finally:
        s.close()


def mcp_list():
    from core.database import McpServer
    s = db()
    try:
        out({"servers": [
            {"id": r.id, "name": r.name, "url": r.url, "transport": r.transport, "enabled": bool(r.is_enabled),
             "disabled_tools": json.loads(r.disabled_tools) if r.disabled_tools else []}
            for r in s.query(McpServer).all()
        ]})
    finally:
        s.close()


def mcp_remove(server_id):
    from core.database import McpServer
    s = db()
    try:
        n = s.query(McpServer).filter(McpServer.id == server_id).delete()
        s.commit()
        out({"deleted": n})
    finally:
        s.close()


def provider():
    from src.constants import DATA_DIR
    from src.memory import MemoryManager
    from src.memory_provider import NativeMemoryProvider
    try:
        from src.memory_vector import MemoryVectorStore
        vec = MemoryVectorStore(DATA_DIR)
        vec = vec if vec.healthy else None
    except Exception:
        vec = None
    return NativeMemoryProvider(MemoryManager(DATA_DIR), vec), vec is not None


async def mem_add(owner, payload):
    items = json.loads(base64.b64decode(payload).decode("utf-8"))
    p, has_vec = provider()
    ids = []
    for text in items:
        rec = await p.remember(text, owner=owner, category="project", source=EVAL_SOURCE, metadata={"contextos_eval": True})
        ids.append(rec.id)
    out({"added": len(ids), "vector_index": has_vec, "ids": ids})


async def mem_cleanup(owner):
    p, _ = provider()
    entries = p.memory_manager.load(owner=owner)
    victims = [e["id"] for e in entries if e.get("source") == EVAL_SOURCE]
    for mid in victims:
        await p.delete(mid, owner=owner)
    out({"deleted": len(victims)})


def session_tokens(ids):
    from core.database import Session
    s = db()
    try:
        rows = s.query(Session).filter(Session.id.in_(ids)).all()
        out({r.id: {"input": r.total_input_tokens or 0, "output": r.total_output_tokens or 0, "cost_usd": r.total_cost_usd or 0.0} for r in rows})
    finally:
        s.close()


def main(argv):
    cmd, args = argv[0], argv[1:]
    if cmd == "mcp-register":
        mcp_register(args[0], args[1])
    elif cmd == "mcp-tools":
        mcp_tools(args[0], args[1])
    elif cmd == "mcp-list":
        mcp_list()
    elif cmd == "mcp-remove":
        mcp_remove(args[0])
    elif cmd == "mem-add":
        asyncio.run(mem_add(args[0], args[1]))
    elif cmd == "mem-cleanup":
        asyncio.run(mem_cleanup(args[0]))
    elif cmd == "session-tokens":
        session_tokens(args)
    else:
        out({"error": f"unknown command {cmd}"})


if __name__ == "__main__":
    main(sys.argv[1:])
