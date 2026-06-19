#!/usr/bin/env node
/**
 * MCP stdio binary.
 *
 * Coding agents (Claude Code, Codex, Cursor) spawn this as a child process
 * and talk JSON-RPC over stdio. The shared tool registry lives in
 * `./registry.ts`; this file just builds the runtime, attaches the
 * registry to a Server, and pumps stdio.
 *
 * Logging goes to stderr — stdout is reserved for the JSON-RPC stream.
 */

import { buildRuntime, loadConfig, type Runtime } from "@loctx/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./registry.js";

export type {
  RefreshInput,
  RefreshOutput,
  SearchInput,
  StatusInput,
  StatusOutput,
} from "./registry.js";
export { registerTools, TOOL_DEFINITIONS, ToolError, tools } from "./registry.js";

const SERVER_INFO = { name: "loctx", version: "0.1.0" };

async function main(): Promise<void> {
  // A long-lived stdio server must outlive transient failures. The MCP
  // process builds its own runtime (watcher, reconciler, analyzer queue),
  // so a stray rejection from a background task — or cross-process DB /
  // LanceDB contention while the daemon writes — would otherwise crash the
  // process and surface to the agent as "session expired" with no
  // recovery. Log and keep serving; each tool call still reports its own
  // errors via the dispatch try/catch in registry.ts. (Restarting the
  // daemon is the canonical trigger: #mcp-session-resilience.)
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`[loctx-mcp] unhandledRejection (ignored): ${detail}`);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[loctx-mcp] uncaughtException (ignored): ${err.stack ?? err.message}`);
  });

  const runtime: Runtime = await buildRuntime(loadConfig());
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  registerTools(server, runtime);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr — stdout is the JSON-RPC channel.
  console.error(
    `[loctx-mcp] connected (workspace_roots: ${runtime.config.workspaceRoots.join(", ")})`,
  );

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.error(`[loctx-mcp] received ${signal}, shutting down...`);
    try {
      await server.close();
    } catch (err) {
      console.error(`[loctx-mcp] server.close error: ${(err as Error).message}`);
    }
    await runtime.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
