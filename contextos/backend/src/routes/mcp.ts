import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createContextosMcpServer, type ContextosMcpDeps } from "@contextos/mcp-server";

function jsonRpcError(reply: FastifyReply, status: number, code: number, message: string) {
  return reply.code(status).send({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/**
 * Mounts the ContextOS MCP server at /mcp using stateless Streamable HTTP:
 * a fresh server + transport per POST (the SDK's documented stateless pattern).
 * GET/DELETE are only meaningful for stateful sessions, so they return 405.
 *
 * Phase 7 adds the secret path segment (/mcp/:key) agreed in the design;
 * Phase 1 only proves the transport works.
 */
export function registerMcpRoutes(
  app: FastifyInstance,
  deps: { mcp: ContextosMcpDeps; allowedHosts: string[] },
) {
  // DNS-rebinding protection, equivalent to the SDK's hostHeaderValidation.
  const checkHost = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.host;
    let hostname: string | null = null;
    try {
      hostname = header ? new URL(`http://${header}`).hostname.toLowerCase() : null;
    } catch {
      hostname = null;
    }
    if (!hostname || !deps.allowedHosts.includes(hostname)) {
      return jsonRpcError(reply, 403, -32000, `Host not allowed: ${hostname ?? "(missing)"}`);
    }
  };

  app.post("/mcp", { onRequest: checkHost }, async (request, reply) => {
    const server = createContextosMcpServer(deps.mcp);
    // No sessionIdGenerator => stateless mode (per the SDK's transport options docs).
    const transport = new StreamableHTTPServerTransport({});
    reply.hijack(); // the transport writes the raw response itself
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      request.log.error({ err }, "MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }),
        );
      }
    }
  });

  const notAllowed = (_req: FastifyRequest, reply: FastifyReply) =>
    jsonRpcError(reply, 405, -32000, "Method not allowed (stateless server).");
  app.get("/mcp", { onRequest: checkHost }, notAllowed);
  app.delete("/mcp", { onRequest: checkHost }, notAllowed);
}
