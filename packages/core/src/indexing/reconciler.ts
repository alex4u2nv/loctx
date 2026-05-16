/**
 * Index reconciliation (#14).
 *
 * The watcher catches live filesystem events while the daemon is up.
 * Anything that happens while the daemon is down (a delete, a `git pull`
 * that rewrites a hundred files) is invisible to it. The reconciler
 * closes that gap:
 *
 *   1. Pre-prune — every file the StateStore knows about is checked for
 *      existence on disk; missing files are removed from the index in
 *      one transaction (chunks, FTS rows, symbol_refs, vectors).
 *   2. Re-walk — the indexer's normal `indexProject` is invoked to pick
 *      up new + modified files. Unchanged files no-op via the existing
 *      content-sha guard.
 *   3. Stamp — `last_reconciled_at` on the project row is updated so
 *      `loctx doctor` and the MCP `workspace_status` payload can show
 *      drift.
 *
 * Used by `loctx start`: once at boot when `reconciliation.runOnStart`
 * is true, then periodically every `reconciliation.intervalSeconds`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../models.js";
import type { StateStore } from "../storage/state.js";
import type { VectorStore } from "../storage/vectors.js";
import type { ProjectIndexer } from "./indexer.js";

export interface ReconciliationSummary {
  readonly project: Project;
  /** Files removed from disk that we pruned from the index. */
  readonly pruned: number;
  /** Files reindexed (changed content or never indexed). */
  readonly reindexed: number;
  /** Files skipped (unchanged or filtered out). */
  readonly skipped: number;
  /** Files the indexer couldn't process (read errors etc.). */
  readonly failed: number;
  readonly elapsedSeconds: number;
}

/**
 * Snapshot of the reconciler's live state. Surfaced via `/api/status`
 * and the admin dashboard so users can tell — for the first ~minutes
 * after daemon start, or during a periodic pass on a busy workspace —
 * that search results may be incomplete while the index is catching
 * up. See #216.
 */
export interface ReconciliationStatus {
  readonly running: boolean;
  /** ISO-8601 timestamp of the in-flight pass; null when idle. */
  readonly startedAt: string | null;
  /** Project currently being reconciled; null when idle. */
  readonly currentProjectName: string | null;
  /** How many projects in the current batch are done. */
  readonly completed: number;
  /** Total projects in the current batch. */
  readonly total: number;
}

export class Reconciler {
  private _running = false;
  private _startedAt: string | null = null;
  private _currentProjectName: string | null = null;
  private _completed = 0;
  private _total = 0;

  constructor(
    private readonly state: StateStore,
    private readonly indexer: ProjectIndexer,
    private readonly vectors?: VectorStore,
  ) {}

  status(): ReconciliationStatus {
    return Object.freeze({
      running: this._running,
      startedAt: this._startedAt,
      currentProjectName: this._currentProjectName,
      completed: this._completed,
      total: this._total,
    });
  }

  /**
   * Pre-prune deleted files, drop anything the current filter now
   * excludes, then run a full indexer pass. Idempotent: unchanged
   * files cost one stat + sha + sqlite read each.
   *
   * The filter re-eval pass is what makes ignore-rule changes take
   * effect on already-indexed files. The watcher catches project-level
   * rule files (`.gitignore`, `.loctxignore`, `.cursorignore`, …) live,
   * but global excludes (`~/.gitignore_global`) and rule changes made
   * while the daemon was offline only land here.
   */
  async reconcileProject(project: Project): Promise<ReconciliationSummary> {
    const started = performance.now();

    let pruned = 0;
    for (const fileRow of this.state.listFiles(project.id)) {
      const absPath = join(project.root, fileRow.relPath);
      if (!existsSync(absPath)) {
        await this.indexer.deleteFile(project, fileRow.relPath);
        pruned += 1;
      }
    }

    // Drop already-indexed files that a (newly-loaded) filter now
    // rejects. Cheap: one in-memory shouldIndex() per file.
    const refilter = await this.indexer.reevaluateFilter(project);
    pruned += refilter.pruned;

    // Run the indexer pass; if it throws, do NOT stamp last_reconciled_at
    // because the project's state is partial. Doctor + workspace_status
    // surface the (now-stale) timestamp to tell the operator drift exists.
    const indexSummary = await this.indexer.indexProject(project);
    // Stamp only on full success — a partially-failed reconcile must not
    // mark the project as up-to-date (see #194).
    this.state.markProjectReconciled(project.id);

    return Object.freeze({
      project,
      pruned,
      reindexed: indexSummary.indexed,
      skipped: indexSummary.skipped,
      failed: indexSummary.failed,
      elapsedSeconds: (performance.now() - started) / 1000,
    });
  }

  async reconcileAll(
    projects: ReadonlyArray<Project>,
  ): Promise<ReadonlyArray<ReconciliationSummary>> {
    // Live status: flip running=true for the duration so /api/status can
    // tell the UI that search results may be incomplete during the pass.
    this._running = true;
    this._startedAt = new Date().toISOString();
    this._completed = 0;
    this._total = projects.length;
    const out: ReconciliationSummary[] = [];
    try {
      for (const project of projects) {
        this._currentProjectName = project.name;
        out.push(await this.reconcileProject(project));
        this._completed += 1;
      }
    } finally {
      this._running = false;
      this._currentProjectName = null;
    }
    // Build the ANN index once the post-reconcile corpus has grown
    // past the threshold. Cheap when an index already exists; the
    // builder bails fast in that case (#210).
    if (this.vectors !== undefined) {
      const result = await this.vectors.ensureVectorIndex();
      if (result.built) {
        console.error(`[loctx reconcile] built vector ANN index over ${result.rows} chunks`);
      }
    }
    return Object.freeze(out);
  }
}
