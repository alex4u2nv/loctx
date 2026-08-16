/**
 * projects contracts (split from the 687-line contracts.ts, #542).
 */

import type { ProjectValue } from "./status.js";

export type WatcherState = "active" | "paused" | "failed";

/**
 * Derived per-project health combining watcher state with index state.
 *
 *   - `failed`        watcher errored — needs investigation
 *   - `paused`        watcher manually paused
 *   - `never-indexed` files=0 && lastIndexed=null — needs initial rebuild
 *                     (the watcher only catches *changes*, not initial state)
 *   - `empty`         files=0 but lastIndexed!=null — filter excluded everything
 *   - `errors`        files>0 but some failed indexing
 *   - `indexing`      a rebuild is actively running for this project
 *   - `reconciling`   the daemon's reconciler is mid-pass on this project
 *   - `active`        watching + has data
 *   - `ready`         indexed, no watcher (daemon started with --no-watch)
 *   - `orphaned`      project no longer under workspace_roots
 *
 *   `indexing` + `reconciling` are transient — they appear only while
 *   work is happening and revert to active/ready when the daemon
 *   finishes. They take precedence over `active`/`ready` so the badge
 *   on /projects accurately mirrors the in-flight state shown in the
 *   timestamp column.
 */
export type ProjectHealth =
  | "failed"
  | "paused"
  | "never-indexed"
  | "empty"
  | "errors"
  | "indexing"
  | "reconciling"
  | "active"
  | "ready"
  | "orphaned";

export interface ProjectsRow {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly marker: string | null;
  readonly markerKind: string | null;
  readonly files: number;
  readonly chunks: number;
  readonly errors: number;
  readonly lastIndexed: string | null;
  readonly lastReconciled: string | null;
  /**
   * Watcher runtime state. `null` when no watcher is registered
   * (orphaned projects, or daemon started with --no-watch).
   */
  readonly watcher: WatcherState | null;
  /** Most recent failure reason if `watcher === "failed"`. */
  readonly watcherFailure: string | null;
  /** Combined health signal — what the user should care about at a glance. */
  readonly health: ProjectHealth;
  /** One-line hint matching `health` (e.g. "click rebuild to populate"). */
  readonly healthHint: string;
  /**
   * In-flight or recently-finished rebuild for this project. Null when
   * no rebuild has been requested recently. Lives in the daemon's
   * in-memory RebuildTracker; lost on daemon restart.
   */
  readonly rebuilding: RebuildProgress | null;
  /**
   * Persisted "rebuild requested" timestamp surviving daemon restarts.
   * Set when the user clicks rebuild, cleared once the post-rebuild
   * reconcile completes. The UI uses this to render "resuming
   * rebuild…" on a row whose rebuild was interrupted by a daemon
   * stop, even though the in-memory tracker is empty.
   */
  readonly rebuildPendingAt: string | null;
  /**
   * Inner project markers absorbed by this project (#286). Each entry is
   * a subdirectory under `root` that carries its own project marker
   * (`.git`, `package.json`, etc.) but is indexed as part of the parent.
   * Empty array when none.
   */
  readonly absorbedMarkers: ReadonlyArray<AbsorbedMarkerRow>;
  /**
   * In-flight reconcile signal for this specific project. When non-null,
   * the daemon is currently reconciling this project — the UI should
   * render "reconciling…" instead of the stale `lastReconciled` stamp.
   * Carries file progress when the indexer has reported it; null fields
   * mean the walk hasn't started reporting yet (pre-stat phase).
   */
  readonly reconciling: {
    readonly indexed: number | null;
    readonly total: number | null;
  } | null;
  /**
   * Estimated value loctx has served for this project (#value-metrics):
   * tokens saved, queries served, file reads avoided. `null` until a
   * retrieval query has touched the project.
   */
  readonly value: ProjectValue | null;
}

export interface AbsorbedMarkerRow {
  readonly relPath: string;
  readonly marker: string;
  readonly markerKind: string;
}

export interface RebuildProgress {
  readonly status: "running" | "done" | "failed";
  readonly indexed: number;
  /** Null until the file walk completes (the indexer fires onProgress with total once known). */
  readonly totalFiles: number | null;
  readonly startedAt: number; // epoch ms
  readonly completedAt: number | null;
  readonly error: string | null;
}

export interface OrphanRow extends ProjectsRow {
  readonly reason: string;
  readonly rootExists: boolean;
}

/**
 * Discovered under `workspace_roots` but the user hasn't activated it
 * (or has explicitly deactivated it). UI surfaces these with an
 * Activate button; indexer / watcher / reconciler skip them.
 */
export interface InactiveRow {
  readonly id: string;
  readonly name: string;
  readonly root: string;
  readonly marker: string | null;
  readonly markerKind: string | null;
  /** True when a state row already exists with active=0; false for never-recorded projects. */
  readonly known: boolean;
}

export interface ProjectsPayload {
  readonly active: ReadonlyArray<ProjectsRow>;
  readonly inactive: ReadonlyArray<InactiveRow>;
  readonly orphaned: ReadonlyArray<OrphanRow>;
  /**
   * Longest common directory prefix shared by every active row's `root`,
   * with no trailing slash. Empty when there's nothing meaningful in
   * common. The client hides this prefix in row paths and shows it once
   * as a header so wide workspaces stay scannable.
   */
  readonly commonRoot: string;
  /** OS home directory; client renders `~` in its place when present. */
  readonly homeDir: string;
}

/**
 * Per-project deep-dive payload behind `GET /api/projects/:id`. The UI
 * uses this for the `/projects/:id` inspect view: header card + stats
 * tables + a scoped search/find-usages panel that reuses the existing
 * /api/search and /api/find-usages endpoints with `path` pre-set.
 */
export interface ProjectDetailPayload {
  readonly project: ProjectsRow;
  readonly stats: ProjectStats;
}

export interface ProjectStats {
  /** File + chunk counts grouped by file extension (".ts", ".py", "<none>"). */
  readonly byExtension: ReadonlyArray<{
    readonly ext: string;
    readonly files: number;
    readonly chunks: number;
  }>;
  /** Files with the most chunks (largest contributors). Capped server-side. */
  readonly topFiles: ReadonlyArray<{
    readonly relPath: string;
    readonly chunks: number;
    readonly indexedAt: string | null;
  }>;
  /** Most-recently-indexed files. Capped server-side. */
  readonly recentFiles: ReadonlyArray<{
    readonly relPath: string;
    readonly indexedAt: string | null;
  }>;
  /** Every file whose `error` column is non-null. Helps drill into indexing failures. */
  readonly failingFiles: ReadonlyArray<{
    readonly relPath: string;
    readonly error: string;
  }>;
}

export interface WatchersPayload {
  readonly enabled: boolean;
  readonly entries: ReadonlyArray<{
    readonly projectId: string;
    readonly projectName: string;
    readonly projectRoot: string;
    readonly state: WatcherState;
    readonly startedAt: string;
    readonly failureReason: string | null;
  }>;
}
