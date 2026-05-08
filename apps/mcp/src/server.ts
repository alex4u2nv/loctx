#!/usr/bin/env node
/**
 * MCP stdio binary.
 *
 * The transport-agnostic tool registry lives in `./registry.ts`. This file
 * is the stdio entry point: it builds the runtime once, attaches the
 * registry to a Server, and pumps stdio.
 *
 * Real stdio wiring (Server + StdioServerTransport) lands in M6#2; this
 * file currently logs a notice and exits — the SSE route in
 * `apps/web/app/mcp/route.ts` (M6#3) is the other consumer of the registry.
 */

export { TOOL_DEFINITIONS, ToolError, registerTools, tools } from "./registry.js";
export type {
  RefreshInput,
  RefreshOutput,
  SearchInput,
  StatusInput,
  StatusOutput,
} from "./registry.js";

async function main(): Promise<void> {
  // TODO (M6#2): build runtime, create Server, attach StdioServerTransport,
  // call registerTools(server, runtime), await server.connect(transport).
  console.error(
    "[loctx-mcp] stdio wiring pending (M6#2). The tool registry is exported and " +
      "consumed by the Next.js SSE route (M6#3). Run `loctx start` for the integrated daemon.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
