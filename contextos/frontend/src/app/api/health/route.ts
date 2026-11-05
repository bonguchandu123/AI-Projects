import { checkBackend } from "@/lib/backend";

/**
 * Frontend health: the Next.js server is up, plus whether it can reach a ready
 * backend. 200 only when the whole chain (frontend -> backend -> database) is ready.
 */
export async function GET() {
  const backend = await checkBackend();
  const ready = backend.reachable && backend.status.ready;
  return Response.json({ frontend: "ok", ready, backend }, { status: ready ? 200 : 503 });
}
