/**
 * Coalescer for analyzer completion events (#526).
 *
 * The enrichment queue settles one task per (file, analyzer); a
 * backfill enqueues thousands. Publishing per task — or even per
 * (analyzer, project) bucket — would flood the SSE stream, and every
 * SSE message ticks every live-refresh subscriber in the admin UI. So
 * completions accumulate per (analyzer, project) and flush as ONE
 * {@link AnalyzerBusEvent} per window carrying all batches.
 *
 * One shared timer: the first record after an idle period arms it;
 * everything recorded before it fires rides the same flush. The timer
 * is unref'd so a draining process can still exit — which also means a
 * hard shutdown may drop the final window; that's acceptable, the SSE
 * clients the event serves are gone by then.
 */

import type { AnalyzerBatch, AnalyzerBusEvent } from "./bus.js";

interface Bucket {
  readonly analyzer: string;
  readonly projectId: string;
  completed: number;
  failed: number;
}

const DEFAULT_WINDOW_MS = 2_000;

export class AnalyzerEventCoalescer {
  private readonly buckets = new Map<string, Bucket>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly publish: (event: AnalyzerBusEvent) => void,
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
  ) {}

  /** Record one settled task; arms the flush timer if idle. */
  record(analyzer: string, projectId: string, status: "complete" | "failed"): void {
    const key = `${analyzer} ${projectId}`;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { analyzer, projectId, completed: 0, failed: 0 };
      this.buckets.set(key, bucket);
    }
    if (status === "complete") bucket.completed += 1;
    else bucket.failed += 1;
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.windowMs);
      this.timer.unref();
    }
  }

  /** Publish every pending batch as one event. Safe to call when idle (no-op). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buckets.size === 0) return;
    // Snapshot + clear BEFORE publishing: a bus listener may record()
    // re-entrantly, and a throwing listener must not leave delivered
    // batches behind to double-publish on the next flush.
    const batches: AnalyzerBatch[] = [...this.buckets.values()].map((b) => ({ ...b }));
    this.buckets.clear();
    try {
      this.publish({ type: "analyzer", batches, at: Date.now() });
    } catch (err) {
      // EventEmitter.emit rethrows listener errors synchronously; from
      // the timer path an escape would kill the process. The event is a
      // UI hint — log and move on.
      console.error(`[analyzer-events] bus listener threw: ${(err as Error).message}`);
    }
  }
}
