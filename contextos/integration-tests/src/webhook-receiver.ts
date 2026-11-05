/**
 * Phase 1 probe: minimal receiver for Odysseus outbound webhooks.
 *
 * Mirrors what Odysseus actually sends (src/webhook_manager.py `_deliver`):
 *   POST, Content-Type: application/json, User-Agent: Odysseus-Webhook/1.0
 *   X-Odysseus-Event: <event>
 *   X-Odysseus-Signature: hex(HMAC-SHA256(secret, raw_body))   (only if a secret is set)
 *   body = {"event": str, "timestamp": ISO-8601 UTC (naive), "data": {...}}
 *
 * The signature covers the exact raw bytes, so we verify BEFORE parsing JSON.
 * Every delivery is appended to captures/events.jsonl as evidence.
 */
import { createServer, type IncomingMessage } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.WEBHOOK_SECRET ?? "";
const MAX_BODY_BYTES = 1_000_000;
const CAPTURE_FILE = "captures/events.jsonl";

mkdirSync("captures", { recursive: true });

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

type SigResult = "valid" | "invalid" | "missing" | "no-secret-configured";

function checkSignature(raw: Buffer, header: string | undefined): SigResult {
  if (!SECRET) return "no-secret-configured";
  if (!header) return "missing";
  const expected = createHmac("sha256", SECRET).update(raw).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b) ? "valid" : "invalid";
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  if (req.method !== "POST" || req.url !== "/hook") {
    res.writeHead(404).end();
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    res.writeHead(413).end();
    return;
  }

  const sig = checkSignature(raw, req.headers["x-odysseus-signature"] as string | undefined);
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    /* recorded below as unparseable */
  }

  const data = parsed?.data ?? {};
  const summary = {
    received_at: new Date().toISOString(),
    header_event: req.headers["x-odysseus-event"] ?? null,
    user_agent: req.headers["user-agent"] ?? null,
    signature: sig,
    body_event: parsed?.event ?? null,
    body_timestamp: parsed?.timestamp ?? null,
    data_keys: Object.keys(data),
    lengths: Object.fromEntries(
      Object.entries(data)
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => [k, (v as string).length]),
    ),
    raw_bytes: raw.length,
  };

  appendFileSync(CAPTURE_FILE, JSON.stringify({ ...summary, body: parsed ?? raw.toString("utf8") }) + "\n");
  console.log(JSON.stringify(summary, null, 2));

  // Reject bad signatures the way ContextOS will in production.
  if (SECRET && sig !== "valid") {
    res.writeHead(401).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end('{"received":true}');
});

server.listen(PORT, HOST, () => {
  console.log(`webhook receiver listening on http://${HOST}:${PORT}/hook`);
  console.log(SECRET ? "signature verification: ON" : "signature verification: OFF (set WEBHOOK_SECRET)");
});
