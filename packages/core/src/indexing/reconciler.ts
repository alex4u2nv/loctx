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

export class Reconciler {
  constructor(
    private readonly state: StateStore,
    private readonly indexer: ProjectIndexer,
  ) {}

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
    const out: ReconciliationSummary[] = [];
    for (const project of projects) {
      out.push(await this.reconcileProject(project));
    }
    return Object.freeze(out);
  }
}
