/**
 * Process-wide event bus for filesystem watcher events.
 *
 * The integrated daemon (loctx start) runs the WatcherService and the
 * Next.js admin UI in the same Node process. The watcher publishes
 * events to this singleton bus; the admin UI subscribes via an SSE
 * endpoint and refreshes affected pages.
 *
 * For separate-process deployments (where the watcher runs apart from
 * the web UI), the bus is a no-op — the UI just relies on the
 * `force-dynamic` pages to refetch StateStore on each request.
 */

import { EventEmitter } from "node:events";

export type WatcherEventKind = "add" | "change" | "unlink";

export interface WatcherEvent {
  readonly projectId: string;
  readonly projectName: string;
  readonly relPath: string;
  readonly kind: WatcherEventKind;
  readonly at: number; // epoch ms
}

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
