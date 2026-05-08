/**
 * MCP HTTP transport mounted on the Next.js port.
 *
 * Single endpoint at `/mcp` handles both POST (JSON-RPC requests) and GET
 * (SSE upgrade) per the MCP Streamable HTTP spec. The shared tool registry
 * from `apps/mcp/src/registry.ts` is wired onto a Server instance once at
 * module load — subsequent requests reuse the same Runtime + Server.
 *
 * Stateless mode: every request is a self-contained call. No session IDs.
 * Suitable for the integrated daemon where one Next.js server hosts both
 * the admin UI (other routes) and the MCP endpoint.
 */

import { type Runtime, buildRuntime, loadConfig } from "@loctx/core";
import { registerTools } from "@loctx/mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_INFO = { name: "loctx", version: "0.1.0" };

// Build the runtime + server once, lazily, on first request. Cached promise
// so concurrent first-touches don't double-build.
let bootP: Promise<{
  runtime: Runtime;
  transport: WebStandardStreamableHTTPServerTransport;
}> | null = null;

function boot() {
  if (bootP !== null) return bootP;
  bootP = (async () => {
    const runtime = await buildRuntime(loadConfig());
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
    registerTools(server, runtime);

    // Stateless mode — no session IDs. Pass an empty options object;
    // omitting `sessionIdGenerator` selects stateless per the SDK.
    const transport = new WebStandardStreamableHTTPServerTransport({});
    await server.connect(transport);
    return { runtime, transport };
  })();
  return bootP;
}

export async function GET(request: Request): Promise<Response> {
  const { transport } = await boot();
  return transport.handleRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  const { transport } = await boot();
  return transport.handleRequest(request);
}

export async function DELETE(request: Request): Promise<Response> {
  const { transport } = await boot();
  return transport.handleRequest(request);
}
