/**
 * MCP HTTP transport mounted on the Next.js port.
 *
 * GET / POST / DELETE on `/mcp` flow through the MCP Streamable HTTP spec.
 * Stateless mode — every request gets a fresh Server + Transport pair
 * connected to the same shared Runtime (heavy: holds the embedding model
 * and SQLite handle, built once on first request).
 */

import { type Runtime, buildRuntime, loadConfig } from "@loctx/core";
import { registerTools } from "@loctx/mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVER_INFO = { name: "loctx", version: "0.1.0" };

let runtimeP: Promise<Runtime> | null = null;

function getRuntime(): Promise<Runtime> {
  if (runtimeP === null) runtimeP = buildRuntime(loadConfig());
  return runtimeP;
}

async function handle(request: Request): Promise<Response> {
  const rt = await getRuntime();
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  registerTools(server, rt);
  // Stateless: each request gets a fresh transport. Closing it eagerly
  // truncates the streamed response — the SDK and GC clean up after the
  // client consumes the body.
  const transport = new WebStandardStreamableHTTPServerTransport({});
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
