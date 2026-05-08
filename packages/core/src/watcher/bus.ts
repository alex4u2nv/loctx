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

class WatcherBus extends EventEmitter {
  publish(event: WatcherEvent): void {
    this.emit("event", event);
  }

  subscribe(listener: (event: WatcherEvent) => void): () => void {
    this.on("event", listener);
    return () => {
      this.off("event", listener);
    };
  }
}

/** Singleton — every importer in the same Node process sees the same bus. */
export const watcherBus = new WatcherBus();
