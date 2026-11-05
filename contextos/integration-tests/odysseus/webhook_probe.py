"""
Phase-1 integration probe: run Odysseus's REAL webhook delivery code
(src/webhook_manager.WebhookManager._deliver: same JSON envelope, same
HMAC-SHA256 X-Odysseus-Signature, same pinned httpx transport) against the
local ContextOS ingestion endpoint.

Odysseus refuses private/loopback webhook URLs (SSRF protection, verified in
source and in the running container), so ONLY inside this throwaway Python
process the two URL-validation helpers are replaced. Odysseus's files, its
database and its running server are not modified; no public tunnel is used.

What this does NOT prove: that a chat turn in the running Odysseus server
triggers the delivery (that path is blocked for local URLs by design).

Run:
  docker exec -i -w /app -e CONTEXTOS_WEBHOOK_SECRET=<secret> odysseus-odysseus-1 python - < integration-tests/odysseus/webhook_probe.py
"""
import asyncio
import ipaddress
import json
import os
import socket
import sys
import time

sys.path.insert(0, "/app")
URL = os.environ.get("CONTEXTOS_WEBHOOK_URL", "http://host.docker.internal:4000/api/webhooks/odysseus")
SECRET = os.environ["CONTEXTOS_WEBHOOK_SECRET"]


async def main() -> int:
    import httpx
    import src.webhook_manager as wm

    host = URL.split("//", 1)[1].split("/", 1)[0].split(":")[0]
    ipv4 = [i[4][0] for i in socket.getaddrinfo(host, None, socket.AF_INET)]
    target_ip = ipaddress.ip_address(ipv4[0])
    print("RESOLVED", host, "->", target_ip)

    # Probe-local bypass of the private-address guard (this process only).
    wm.validate_webhook_url = lambda url: url
    wm._validated_public_ips = lambda url: [target_ip]

    # Capture the HTTP status from Odysseus's own send path.
    manager = wm.WebhookManager()
    original_send = manager._send_request
    seen = {}

    async def recording_send(url, body, headers, ip):
        resp = await original_send(url, body, headers, ip)
        seen.update(status=resp.status_code, body=resp.text, sent_headers=sorted(headers), body_bytes=len(body))
        return resp

    manager._send_request = recording_send

    # Same payload shape Odysseus builds in routes/chat_helpers.py (chat.completed).
    full_response = (
        "Got it. I'll remember that StudyMate's search will run on Algolia. " + "Details. " * 400
    )
    payload = {
        "session_id": f"odysseus-probe-{int(time.time())}",  # unique per run, so the first delivery is new
        "model": "local-model",
        "user_message": "For StudyMate we decided to use Algolia for course search because it has typo tolerance.",
        "response": full_response[:2000],
    }
    await manager._deliver("ctxprobe", URL, SECRET, "chat.completed", payload)
    print("DELIVERY", json.dumps(seen))

    # Re-deliver the identical exchange: ContextOS must report it as a duplicate.
    await manager._deliver("ctxprobe", URL, SECRET, "chat.completed", payload)
    print("REDELIVERY", json.dumps({"status": seen.get("status"), "body": seen.get("body")}))

    # Wrong secret: must be rejected.
    await manager._deliver("ctxprobe", URL, "wrong-secret", "chat.completed", dict(payload, session_id="other"))
    print("WRONG_SECRET", json.dumps({"status": seen.get("status")}))
    return 0


sys.exit(asyncio.run(main()))
