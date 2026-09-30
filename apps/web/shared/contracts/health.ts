/**
 * Code Health (#health) wire types. The score model itself lives in
 * core (`CodeHealth`); the web adds the persisted-snapshot envelope and
 * the compact per-row summary the projects table renders.
 */

import type { CodeHealth } from "@loctx/core";

/** Compact form on every projects-table row. Null until first scored. */
export interface CodeHealthSummary {
  readonly score: number;
  readonly grade: string;
  readonly computedAt: string;
  /** Score of the snapshot before this one; null when this is the first. */
  readonly previousScore: number | null;
}

export interface CodeHealthHistoryPoint {
  readonly computedAt: string;
  readonly score: number;
  readonly grade: string;
}

/**
 * `GET /api/projects/:id/health` (read-only) and the response of
 * `POST /api/projects/:id/health/recompute`.
 */
export interface CodeHealthPayload {
  readonly projectId: string;
  readonly projectName: string;
  /**
   * Latest snapshot for the current scoring model, or null when the
   * project hasn't been scored yet (the daemon scores once an index
   * pass settles; recompute forces it).
   */
  readonly snapshot: { readonly computedAt: string; readonly health: CodeHealth } | null;
  /** Newest first, change-log semantics (identical rescoring writes nothing). */
  readonly history: ReadonlyArray<CodeHealthHistoryPoint>;
}
