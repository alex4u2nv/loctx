/**
 * doctor contracts (split from the 687-line contracts.ts, #542).
 */

export type DoctorCheckStatus = "ok" | "warn" | "error";

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
}

export interface McpToolsPayload {
  /** Same shape MCP hosts see via `tools/list`. Surfaces tool name +
   * full description so the web "Add loctx as an MCP server" modal can
   * preview what's installed. inputSchema is intentionally omitted —
   * the modal's audience is humans, not agents. */
  readonly tools: ReadonlyArray<McpToolInfo>;
}

export interface DoctorPayload {
  readonly checks: ReadonlyArray<{
    readonly name: string;
    /** Tri-state from core's runDoctorChecks. The web UI used to
     * collapse this to a boolean and lost the warn vs error
     * distinction — yellow vs red matters when scanning a long
     * checks list. */
    readonly status: DoctorCheckStatus;
    readonly detail: string;
  }>;
  readonly summary: string;
}
