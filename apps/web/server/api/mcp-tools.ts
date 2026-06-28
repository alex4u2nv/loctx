/**
 * Return the same tool catalog MCP hosts see via `tools/list`. Used
 * by the web "Add loctx as an MCP server" modal so users can preview
 * what tools their agent will receive after connecting. Read-only;
 * no runtime needed — TOOL_DEFINITIONS is a static catalog.
 */

import type { Config } from "@loctx/core";
import { ADMIN_TOOL_DEFINITION, TOOL_DEFINITIONS } from "@loctx/mcp";
import type { Hono } from "hono";
import type { McpToolsPayload } from "../../shared/contracts.js";

export function mountMcpTools(app: Hono, config: Config): void {
  app.get("/api/mcp-tools", (c) => {
    // Mirror what `tools/list` exposes: the privileged admin_workspace tool
    // is only handed to a connected client when mcp.admin_enabled is set, so
    // the preview should include it only then.
    const defs = config.mcp?.adminEnabled
      ? [...TOOL_DEFINITIONS, ADMIN_TOOL_DEFINITION]
      : TOOL_DEFINITIONS;
    const payload: McpToolsPayload = {
      tools: defs.map((t) => ({ name: t.name, description: t.description })),
    };
    return c.json(payload);
  });
}
