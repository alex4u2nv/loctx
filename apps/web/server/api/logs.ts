import type { Config, Runtime } from "@loctx/core";
import type { Hono } from "hono";
import type { McpLogEntry, McpLogsPayload } from "../../shared/contracts.js";

/**
 * MCP request-log endpoints backing the admin Logs page (#380-era).
 * Reads from the shared `mcp_requests` table the registry dispatch
 * writes to — so every agent `tools/call`, over stdio or HTTP, shows up
 * here for quality tuning.
 */
export function mountLogs(app: Hono, config: Config, getRuntime: () => Promise<Runtime>): void {
  app.get("/api/logs", async (c) => {
    const maxRows = config.mcp.logMaxRows;
    const rt = await getRuntime();
    // Never return more than the retention bound; that's all the table
    // ever holds. `0` (logging disabled) yields an empty list.
    const entries: ReadonlyArray<McpLogEntry> =
      maxRows <= 0 ? [] : rt.state.listMcpRequests(maxRows).map(toEntry);
    const payload: McpLogsPayload = {
      entries,
      maxRows,
      total: rt.state.countMcpRequests(),
    };
    return c.json(payload);
  });

  app.post("/api/logs/clear", async (c) => {
    const rt = await getRuntime();
    rt.state.clearMcpRequests();
    return c.json({ ok: true as const });
  });
}

// Defensive read cap: pre-cap rows (logged before the write-side cap) can
// be tens of MB; serializing the whole table then overflows JSON.stringify
// (RangeError: Invalid string length → 500). Truncate per field on read so
// legacy giant rows still render.
const FIELD_MAX = 256 * 1024; // 256 KB

function cap(value: string | null): string | null {
  if (value === null || value.length <= FIELD_MAX) return value;
  return `${value.slice(0, FIELD_MAX)}\n…[truncated ${value.length - FIELD_MAX} chars]`;
}

function toEntry(row: {
  id: number;
  requestedAt: string;
  tool: string;
  argumentsJson: string;
  responseJson: string | null;
  error: string | null;
  ok: boolean;
  elapsedMs: number;
}): McpLogEntry {
  return {
    id: row.id,
    requestedAt: row.requestedAt,
    tool: row.tool,
    argumentsJson: cap(row.argumentsJson) ?? "",
    responseJson: cap(row.responseJson),
    error: row.error,
    ok: row.ok,
    elapsedMs: row.elapsedMs,
  };
}
