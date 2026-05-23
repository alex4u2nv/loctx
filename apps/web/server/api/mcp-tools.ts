/**
 * Return the same tool catalog MCP hosts see via `tools/list`. Used
 * by the web "Add loctx as an MCP server" modal so users can preview
 * what tools their agent will receive after connecting. Read-only;
 * no runtime needed — TOOL_DEFINITIONS is a static catalog.
 */

import { TOOL_DEFINITIONS } from "@loctx/mcp";
import type { Hono } from "hono";
import type { McpToolsPayload } from "../../shared/contracts.js";

export function mountMcpTools(app: Hono): void {
  app.get("/api/mcp-tools", (c) => {
    const payload: McpToolsPayload = {
      tools: TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description })),
    };
    return c.json(payload);
  });
}
