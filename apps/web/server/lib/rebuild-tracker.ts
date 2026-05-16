/**
 * Tracks in-flight `/api/rebuild` jobs so the projects route can render
 * per-row progress and the SSE feed can announce state changes.
 *
 * In-memory, single-process. A daemon restart loses tracker state, but
 * the indexer either committed each file's chunks + rows or didn't —
 * the reconciler picks up the slack on next boot. We never recover an
 * "in-flight" job across restarts.
 *
 * Concurrency: only one rebuild per project is allowed at a time. The
 * tracker's `start` call returns false when a job for the same project
 * is already running so the endpoint can 409 cleanly.
 *
 * Lifecycle: jobs persist in the tracker for `terminalRetentionMs` after
 * completion (success or failure) so the UI has time to render the
 * final state before the row reverts to its normal layout. Cleanup is
 * lazy — triggered on the next read/start, no background timers.
 */

import { watcherBus } from "@loctx/core";

const DEFAULT_TERMINAL_RETENTION_MS = 5_000;
/** Throttle progress SSE emits — embedder fires per-file, which can be ~50/s. */
const PROGRESS_THROTTLE_MS = 500;

export type RebuildStatus = "running" | "done" | "failed";

export interface RebuildJob {
  readonly projectId: string;
  readonly projectName: string;
  readonly status: RebuildStatus;
  readonly indexed: number;
  /** Null until the file walk completes; the indexer fires onProgress with total once known. */
  readonly totalFiles: number | null;
  readonly startedAt: number; // epoch ms
  readonly completedAt: number | null; // epoch ms
  readonly error: string | null;
}

export interface RebuildTracker {
  /** Try to begin a job. Returns null when one for this projectId is already running. */
  start(projectId: string, projectName: string): RebuildJob | null;
  recordProgress(projectId: string, indexed: number, totalFiles: number | null): void;
  finish(projectId: string): void;
  fail(projectId: string, error: string): void;
  /** Snapshot for a single project; null when no recent job exists. */
  get(projectId: string): RebuildJob | null;
  /** All non-expired jobs keyed by projectId. */
  snapshot(): Map<string, RebuildJob>;
}

export function createRebuildTracker(
  options: { now?: () => number; terminalRetentionMs?: number } = {},
): RebuildTracker {
  const now = options.now ?? (() => Date.now());
  const terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
  const jobs = new Map<string, RebuildJob>();
  const lastEmit = new Map<string, number>();

  const sweep = (): void => {
    const cutoff = now() - terminalRetentionMs;
    for (const [id, job] of jobs) {
      if (job.completedAt !== null && job.completedAt < cutoff) jobs.delete(id);
    }
  };

  const emit = (job: RebuildJob, force: boolean): void => {
    if (!force) {
      const last = lastEmit.get(job.projectId) ?? 0;
      if (now() - last < PROGRESS_THROTTLE_MS) return;
    }
    lastEmit.set(job.projectId, now());
    watcherBus.publish({
      type: "rebuild",
      projectId: job.projectId,
      projectName: job.projectName,
      status: job.status,
      indexed: job.indexed,
      totalFiles: job.totalFiles,
      ...(job.error !== null ? { error: job.error } : {}),
      at: now(),
    });
  };

  return {
    start(projectId, projectName) {
      sweep();
      const existing = jobs.get(projectId);
      if (existing !== undefined && existing.status === "running") return null;
      const job: RebuildJob = Object.freeze({
        projectId,
        projectName,
        status: "running",
        indexed: 0,
        totalFiles: null,
        startedAt: now(),
        completedAt: null,
        error: null,
      });
      jobs.set(projectId, job);
      lastEmit.delete(projectId);
      emit(job, true);
      return job;
    },
    recordProgress(projectId, indexed, totalFiles) {
      const current = jobs.get(projectId);
      if (current === undefined || current.status !== "running") return;
      const next: RebuildJob = Object.freeze({ ...current, indexed, totalFiles });
      jobs.set(projectId, next);
      emit(next, false);
    },
    finish(projectId) {
      const current = jobs.get(projectId);
      if (current === undefined) return;
      const next: RebuildJob = Object.freeze({
        ...current,
        status: "done",
        completedAt: now(),
      });
      jobs.set(projectId, next);
      emit(next, true);
    },
    fail(projectId, error) {
      const current = jobs.get(projectId);
      if (current === undefined) return;
      const next: RebuildJob = Object.freeze({
        ...current,
        status: "failed",
        completedAt: now(),
        error,
      });
      jobs.set(projectId, next);
      emit(next, true);
    },
    get(projectId) {
      sweep();
      return jobs.get(projectId) ?? null;
    },
    snapshot() {
      sweep();
      return new Map(jobs);
    },
  };
}
