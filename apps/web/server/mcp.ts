/**
 * MCP Streamable HTTP transport mounted on /mcp.
 *
 * Stateless: every request gets a fresh Server + Transport pair connected
 * to the shared Runtime. Identical wire shape to the previous Next.js
 * route, so existing MCP clients keep working unchanged.
 */

import type { Runtime } from "@loctx/core";
import { registerTools } from "@loctx/mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";

const SERVER_INFO = { name: "loctx", version: "0.1.0" };

export function mountMcp(app: Hono, getRuntime: () => Promise<Runtime>): void {
  const handle = async (request: Request): Promise<Response> => {
    const rt = await getRuntime();
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
    registerTools(server, rt);
    const transport = new WebStandardStreamableHTTPServerTransport({});
    await server.connect(transport);
    return transport.handleRequest(request);
  };

  app.all("/mcp", (c) => handle(c.req.raw));
}
