/**
 * Process-wide event bus for control-plane events the admin UI tails:
 * filesystem watcher events plus rebuild-job progress.
 *
 * The integrated daemon (loctx start) runs the WatcherService and the
 * admin UI in the same Node process. Publishers (watcher, rebuild
 * tracker) push events here; the admin UI subscribes via an SSE
 * endpoint and refreshes affected pages.
 *
 * For separate-process deployments (where the watcher runs apart from
 * the web UI), the bus is a no-op — the UI just relies on its
 * route-level reload paths to refetch StateStore on each request.
 */

import { EventEmitter } from "node:events";

export type WatcherEventKind = "add" | "change" | "unlink";

export interface WatcherFsEvent {
  readonly type: "fs";
  readonly projectId: string;
  readonly projectName: string;
  readonly relPath: string;
  readonly kind: WatcherEventKind;
  readonly at: number; // epoch ms
}

/**
 * Emitted by the rebuild tracker as a project's rebuild job starts,
 * makes progress, or terminates. The client uses this to refresh
 * /api/projects without polling and to render per-row progress text.
 */
export interface RebuildBusEvent {
  readonly type: "rebuild";
  readonly projectId: string;
  readonly projectName: string;
  readonly status: "running" | "done" | "failed";
  /** Files written so far. Always populated, including on terminal events. */
  readonly indexed: number;
  /** Total file count once the walk completes; null while still discovering. */
  readonly totalFiles: number | null;
  /** Present when status is "failed". */
  readonly error?: string;
  readonly at: number; // epoch ms
}

/** One (analyzer, project) batch inside an {@link AnalyzerBusEvent}. */
export interface AnalyzerBatch {
  readonly analyzer: string;
  readonly projectId: string;
  /** Tasks in this batch that completed successfully. */
  readonly completed: number;
  /** Tasks in this batch that failed. */
  readonly failed: number;
}

/**
 * Emitted when background-analyzer tasks settle (#526). Coalesced by
 * {@link AnalyzerEventCoalescer}: ONE event per window carrying every
 * (analyzer, project) batch — a backfill enqueues thousands of tasks,
 * and both per-file events and per-bucket events would flood the SSE
 * stream (each SSE message ticks every live-refresh subscriber in the
 * admin UI, so message count is the cost that matters). Counts are
 * batch totals, not single-task flags. Consumers today ride the
 * generic live-refresh tick; nothing branches on this type yet.
 */
export interface AnalyzerBusEvent {
  readonly type: "analyzer";
  readonly batches: ReadonlyArray<AnalyzerBatch>;
  readonly at: number; // epoch ms
}

export type WatcherEvent = WatcherFsEvent | RebuildBusEvent | AnalyzerBusEvent;

/**
 * Closure-bound bus over a private EventEmitter. Exposes a typed
 * `publish` + `subscribe` (with disposer) instead of leaking
 * EventEmitter's untyped `emit`/`on`/`off` to consumers.
 */
function createWatcherBus(): WatcherBus {
  const emitter = new EventEmitter();
  return {
    publish: (event) => {
      emitter.emit("event", event);
    },
    subscribe: (listener) => {
      emitter.on("event", listener);
      return () => {
        emitter.off("event", listener);
      };
    },
  };
}

export interface WatcherBus {
  readonly publish: (event: WatcherEvent) => void;
  readonly subscribe: (listener: (event: WatcherEvent) => void) => () => void;
}

/** Singleton — every importer in the same Node process sees the same bus. */
export const watcherBus: WatcherBus = createWatcherBus();
