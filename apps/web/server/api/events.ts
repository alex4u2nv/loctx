/**
 * Watcher SSE feed. The integrated daemon runs WatcherService in the
 * same process; the in-process `watcherBus` is the same instance both
 * write and read here. In split-process deployments the connection
 * stays open but idle.
 */

import { type WatcherEvent, watcherBus } from "@loctx/core";
import type { Hono } from "hono";

export function mountEvents(app: Hono): void {
  app.get("/api/events", () => {
    const encoder = new TextEncoder();
    // Shared between start() and cancel(): `cancel` receives the
    // cancellation *reason*, not the controller, so the cleanup closure
    // must live at request scope for cancel() to reach it (SRV-7 —
    // the old controller-property stash meant client disconnects only
    // cleaned up when the next heartbeat ping threw, up to 15s later).
    let cleanup: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        const safeEnqueue = (chunk: Uint8Array): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(chunk);
            return true;
          } catch {
            cleanup();
            return false;
          }
        };

        const send = (event: WatcherEvent): void => {
          safeEnqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        const heartbeat = setInterval(() => {
          safeEnqueue(encoder.encode(": ping\n\n"));
        }, 15_000);

        const unsubscribe = watcherBus.subscribe(send);

        cleanup = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
        };

        safeEnqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
