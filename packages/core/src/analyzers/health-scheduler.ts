/**
 * Debounced per-project code-health scoring (#health).
 *
 * A project's score should settle once its index pass AND the analyzer
 * enrichments it queued have landed — not once per file. Every
 * `schedule()` call (file indexed, enrichment completed) restarts a
 * per-project quiet timer; the scorer runs when the project has been
 * quiet for `quietMs`. Overlapping runs for the same project are
 * coalesced: a schedule() during a run marks it dirty and re-runs once
 * afterwards. Timers are unref'd so a closing process never waits on
 * them; `dispose()` drops armed timers and waits for in-flight runs so
 * the store they read is never closed underneath them.
 */

import type { Project } from "../models.js";

export const HEALTH_QUIET_MS = 10_000;

export interface HealthSchedulerOptions {
  readonly quietMs?: number;
  readonly onError?: (project: Project, error: Error) => void;
}

export class HealthScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly dirty = new Map<string, Project>();
  private readonly quietMs: number;
  private readonly onError: (project: Project, error: Error) => void;
  private disposed = false;

  constructor(
    private readonly score: (project: Project) => Promise<unknown>,
    options: HealthSchedulerOptions = {},
  ) {
    this.quietMs = options.quietMs ?? HEALTH_QUIET_MS;
    this.onError = options.onError ?? (() => undefined);
  }

  /** (Re)start the quiet timer for `project`. */
  schedule(project: Project): void {
    if (this.disposed) return;
    if (this.running.has(project.id)) {
      this.dirty.set(project.id, project);
      return;
    }
    const existing = this.timers.get(project.id);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(project.id);
      void this.run(project);
    }, this.quietMs);
    timer.unref?.();
    this.timers.set(project.id, timer);
  }

  /** Projects with a timer armed or a run in flight. */
  pending(): number {
    return this.timers.size + this.running.size;
  }

  /** Drop armed timers, then wait for any run already in flight. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.dirty.clear();
    await Promise.allSettled([...this.running.values()]);
  }

  private run(project: Project): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const task = (async () => {
      try {
        await this.score(project);
      } catch (err) {
        this.onError(project, err instanceof Error ? err : new Error(String(err)));
      } finally {
        this.running.delete(project.id);
        const again = this.dirty.get(project.id);
        this.dirty.delete(project.id);
        if (again !== undefined) this.schedule(again);
      }
    })();
    this.running.set(project.id, task);
    return task;
  }
}
