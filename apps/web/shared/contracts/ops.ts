/**
 * ops contracts (split from the 687-line contracts.ts, #542).
 */

export interface McpLogEntry {
  readonly id: number;
  readonly requestedAt: string;
  readonly tool: string;
  /** Full request arguments, JSON-serialized. */
  readonly argumentsJson: string;
  /** Full response payload, JSON-serialized. Null when the call errored. */
  readonly responseJson: string | null;
  /** Error message when the call failed. Null on success. */
  readonly error: string | null;
  readonly ok: boolean;
  readonly elapsedMs: number;
}

export interface McpLogsPayload {
  readonly entries: ReadonlyArray<McpLogEntry>;
  /** Configured rolling row cap (`mcp.log_max_rows`). 0 means logging is off. */
  readonly maxRows: number;
  /** Rows currently retained (≤ maxRows). */
  readonly total: number;
}

export type OpEvent =
  | { readonly type: "log"; readonly message: string }
  | { readonly type: "progress"; readonly current: number; readonly total: number | null }
  | { readonly type: "done"; readonly summary: string }
  | { readonly type: "error"; readonly error: string };
