/**
 * Server-Sent Events stream for watcher activity.
 *
 * The integrated daemon (loctx start) runs the WatcherService in the same
 * Node process as Next.js, so the in-process `watcherBus` from @loctx/core
 * is the same instance both write and read here.
 *
 * Clients connect via EventSource and call `router.refresh()` on each
 * event so server-rendered admin pages pick up new StateStore rows.
 *
 * In split-process deployments (web only, no integrated watcher) the bus
 * never publishes — the connection stays open but idle. Pages still get
 * fresh data via `force-dynamic` on each navigation.
 */

import { type WatcherEvent, watcherBus } from "@loctx/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: WatcherEvent) => {
        const data = JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 15_000);

      const unsubscribe = watcherBus.subscribe(send);

      // Send a comment so the connection becomes "open" immediately.
      controller.enqueue(encoder.encode(": connected\n\n"));

      // Stash cleanup on the controller so cancel() can find it.
      (controller as unknown as { _cleanup: () => void })._cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
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
}
