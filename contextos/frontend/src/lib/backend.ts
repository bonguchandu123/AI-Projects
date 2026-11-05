import "server-only";

/**
 * Server-side client for the ContextOS backend. The browser never calls the
 * backend directly: pages and route handlers go through this module, so the
 * backend URL (and later its API key) stay on the server.
 */
const BACKEND_URL = process.env.CONTEXTOS_API_URL ?? "http://127.0.0.1:4000";

export interface BackendStatus {
  service: "contextos";
  version: string;
  ready: boolean;
  database: {
    reachable: boolean;
    pgvectorVersion: string | null;
    pendingMigrations: number | null;
    error?: string;
  };
  checkedAt: string;
}

export type BackendCheck =
  | { reachable: true; httpStatus: number; status: BackendStatus }
  | { reachable: false; error: string };

function isBackendStatus(value: unknown): value is BackendStatus {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.service === "contextos" && typeof v.ready === "boolean" && typeof v.database === "object";
}

/** Uncached on purpose: status must reflect the backend right now. */
export async function checkBackend(): Promise<BackendCheck> {
  try {
    // /health/ready answers 503 with a JSON body when not ready; that is still a valid answer.
    const res = await fetch(`${BACKEND_URL}/health/ready`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const body: unknown = await res.json();
    if (!isBackendStatus(body)) {
      return { reachable: false, error: `Unexpected response from ${BACKEND_URL} (HTTP ${res.status})` };
    }
    return { reachable: true, httpStatus: res.status, status: body };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { reachable: false, error: `Cannot reach backend at ${BACKEND_URL}: ${reason}` };
  }
}
