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

        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
        };

        safeEnqueue(encoder.encode(": connected\n\n"));

        (controller as unknown as { _cleanup: () => void })._cleanup = cleanup;
      },
      cancel(controller) {
        const cleanup = (controller as unknown as { _cleanup?: () => void })._cleanup;
        cleanup?.();
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
