/**
 * MCP Streamable HTTP transport mounted on /mcp.
 *
 * Stateless: every request gets a fresh Server + Transport pair connected
 * to the shared Runtime.
 */

import { type Runtime, readPackageVersion } from "@loctx/core";
import { registerTools } from "@loctx/mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";

// Real package version, matching the stdio transport (#481 — a
// hardcoded "0.1.0" survived here after that fix landed for stdio).
const SERVER_INFO = {
  name: "loctx",
  version: readPackageVersion(new URL("../package.json", import.meta.url)),
};

export function mountMcp(
  app: Hono,
  getRuntime: () => Promise<Runtime>,
  onConfigWrite?: () => void | Promise<void>,
): void {
  const handle = async (request: Request): Promise<Response> => {
    const rt = await getRuntime();
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
    // Pass the daemon's config-reload hook so the gated admin_workspace tool
    // (when mcp.admin_enabled) can hot-reload after a set_config write — same
    // live-apply behaviour as the admin Config editor's POST /api/config/write.
    registerTools(server, rt, onConfigWrite !== undefined ? { reloadConfig: onConfigWrite } : {});
    const transport = new WebStandardStreamableHTTPServerTransport({});
    await server.connect(transport);
    return transport.handleRequest(request);
  };

  app.all("/mcp", (c) => handle(c.req.raw));
}
