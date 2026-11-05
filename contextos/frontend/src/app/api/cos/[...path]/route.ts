import "server-only";

/**
 * Same-origin proxy to the ContextOS backend. The browser only ever talks to
 * the Next.js server; the backend URL stays server-side (ADR-007).
 * Only /api/* backend paths are reachable through it.
 */
const BACKEND_URL = process.env.CONTEXTOS_API_URL ?? "http://127.0.0.1:4000";

async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path.some((p) => p === ".." || p.includes("/"))) return Response.json({ error: "Bad path" }, { status: 400 });
  const url = new URL(req.url);
  const target = `${BACKEND_URL}/api/${path.map(encodeURIComponent).join("/")}${url.search}`;
  try {
    const body = req.method === "GET" ? "" : await req.text();
    const res = await fetch(target, {
      method: req.method,
      // Fastify rejects an empty body declared as JSON, so only forward a body when there is one.
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body || undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
    return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  } catch (err) {
    return Response.json(
      { error: `ContextOS backend unreachable at ${BACKEND_URL}: ${err instanceof Error ? err.message : String(err)}`, statusCode: 502 },
      { status: 502 },
    );
  }
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
