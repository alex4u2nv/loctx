/**
 * Background enrichment queue (#61).
 *
 * Heavy analyzers (Lizard, Semgrep, ast-grep, clone detection) must not
 * block file indexing or watcher responsiveness. This queue runs them
 * out-of-band, deduplicates by content hash + analyzer version, and
 * caps concurrency so a single laptop doesn't get pinned.
 *
 * The queue is in-memory. Enqueued tasks survive process restart only
 * if the analyzer's persisted result still matches the file's current
 * content hash; otherwise the next reconciliation re-enqueues.
 *
 * Status surfaces (`loctx doctor`, MCP `workspace_status`):
 *   - depth: tasks currently pending or running
 *   - lastRunAt: ISO timestamp of the most recent completion
 *   - failures: count of tasks that ended in `failed` state since boot
 */

export type EnrichmentStatus = "pending" | "running" | "complete" | "failed" | "skipped";

export interface EnrichmentTask {
  /** Stable identity: analyzer + content-hash + chunk/file scope. */
  readonly id: string;
  /** Analyzer name (e.g. "lizard", "semgrep", "jscpd"). */
  readonly analyzer: string;
  /** Bumped when the analyzer's output schema or rule set changes. */
  readonly analyzerVersion: number;
  /** Content hash the result is keyed against. Dedupe + invalidation. */
  readonly contentSha: string;
  /** The runner produces a JSON-serialisable payload. */
  run(): Promise<unknown>;
}

export interface EnrichmentResult {
  readonly task: EnrichmentTask;
  readonly status: EnrichmentStatus;
  readonly payload?: unknown;
  readonly error?: string;
  readonly enqueuedAt: string;
  readonly completedAt: string;
  readonly elapsedMs: number;
}

export interface EnrichmentQueueOptions {
  /** Max concurrent runners. Conservative default suits laptops. */
  readonly concurrency?: number;
  /** Per-task timeout in milliseconds. */
  readonly perTaskTimeoutMs?: number;
  /**
   * Called once per completed task. Persisting / surfacing happens here.
   * Errors thrown from the sink are logged and swallowed.
   */
  readonly onResult?: (result: EnrichmentResult) => void;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 60_000;

interface QueueSnapshot {
  readonly depth: number;
  readonly running: number;
  readonly lastRunAt: string | null;
  readonly failures: number;
  readonly completed: number;
}

/**
 * Bounded FIFO queue with deduplication by task id. Once a task id
 * completes (or fails), submitting the same id with the same
 * (analyzer, version, contentSha) becomes a no-op until the result is
 * cleared by the caller.
 */
export class EnrichmentQueue {
  private readonly concurrency: number;
  private readonly perTaskTimeoutMs: number;
  private readonly onResult: (result: EnrichmentResult) => void;
  private readonly waiting: EnrichmentTask[] = [];
  private readonly enqueuedAt = new Map<string, string>();
  private readonly seen = new Map<string, EnrichmentResult>();
  private readonly inflight = new Set<string>();
  private failuresSinceBoot = 0;
  private completionsSinceBoot = 0;
  private lastRunAt: string | null = null;
  private draining = false;

  constructor(options: EnrichmentQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.perTaskTimeoutMs = Math.max(100, options.perTaskTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.onResult = options.onResult ?? (() => undefined);
  }

  /**
   * Submit a task. Returns true when the task was enqueued, false when
   * it was deduplicated against an existing pending or completed task
   * with the same id and content hash + analyzer version.
   */
  enqueue(task: EnrichmentTask): boolean {
    const seenResult = this.seen.get(task.id);
    if (
      seenResult !== undefined &&
      seenResult.task.contentSha === task.contentSha &&
      seenResult.task.analyzerVersion === task.analyzerVersion
    ) {
      return false;
    }
    if (this.enqueuedAt.has(task.id)) return false;
    if (this.inflight.has(task.id)) return false;
    this.waiting.push(task);
    this.enqueuedAt.set(task.id, new Date().toISOString());
    void this.drain();
    return true;
  }

  /** Mark a task id as stale so the next enqueue re-runs it. */
  invalidate(id: string): void {
    this.seen.delete(id);
  }

  status(): QueueSnapshot {
    return {
      depth: this.waiting.length + this.inflight.size,
      running: this.inflight.size,
      lastRunAt: this.lastRunAt,
      failures: this.failuresSinceBoot,
      completed: this.completionsSinceBoot,
    };
  }

  /** For tests: wait until every queued task has finished. */
  async drainAll(): Promise<void> {
    while (this.waiting.length > 0 || this.inflight.size > 0) {
      await new Promise<void>((res) => setTimeout(res, 5));
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.waiting.length > 0 && this.inflight.size < this.concurrency) {
        const task = this.waiting.shift();
        if (task === undefined) break;
        this.inflight.add(task.id);
        const enqueued = this.enqueuedAt.get(task.id) ?? new Date().toISOString();
        this.enqueuedAt.delete(task.id);
        void this.runTask(task, enqueued).finally(() => {
          this.inflight.delete(task.id);
          // Schedule another drain pass; if there's nothing left it's a
          // cheap no-op, and if a task arrived during this run it picks
          // it up.
          void this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTask(task: EnrichmentTask, enqueuedAt: string): Promise<void> {
    const started = Date.now();
    let payload: unknown;
    let error: string | undefined;
    let status: EnrichmentStatus = "complete";
    try {
      payload = await this.withTimeout(task.run(), this.perTaskTimeoutMs);
    } catch (err) {
      status = "failed";
      error = (err as Error).message ?? String(err);
      this.failuresSinceBoot += 1;
    }
    const completedAt = new Date().toISOString();
    const result: EnrichmentResult = Object.freeze({
      task,
      status,
      ...(payload !== undefined ? { payload } : {}),
      ...(error !== undefined ? { error } : {}),
      enqueuedAt,
      completedAt,
      elapsedMs: Date.now() - started,
    });
    this.seen.set(task.id, result);
    this.lastRunAt = completedAt;
    if (status === "complete") this.completionsSinceBoot += 1;
    try {
      this.onResult(result);
    } catch (err) {
      console.error(`[enrichment] result sink threw: ${(err as Error).message}`);
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`task timed out after ${ms}ms`));
      }, ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}
