/**
 * Watcher SSE indicator + shared event bus.
 *
 * Previously this component lifted the SSE event through an `onEvent`
 * prop into `<App>`, where it incremented a `tick` counter passed to
 * every route. That caused two real bugs (#249):
 *
 *   1. Navigation glitches — clicking a NavLink during reconciliation
 *      (which fires SSE events many times/sec) interrupted React Router
 *      v7's startTransition-wrapped navigation. The URL updated but
 *      the new lazy route never committed.
 *   2. Wasted work — every route subtree re-rendered on every event,
 *      even routes that don't care (config, models, doctor, …).
 *
 * The new model: one module-level EventSource, two hooks. Routes that
 * want refresh-on-event call `useLiveRefreshEvent(reload)`; everything
 * else is untouched. App owns no SSE state anymore.
 */

import { useEffect, useState } from "react";
import { Icon } from "./icon";

type ConnectionState = "connecting" | "open" | "closed";

let source: EventSource | null = null;
let connectionState: ConnectionState = "connecting";
let lastEventAt: number | null = null;
const eventListeners = new Set<() => void>();
const stateListeners = new Set<(s: ConnectionState, at: number | null) => void>();

function ensureSource(): void {
  if (source !== null) return;
  source = new EventSource("/api/events");
  source.onopen = () => {
    connectionState = "open";
    for (const l of stateListeners) l(connectionState, lastEventAt);
  };
  source.onerror = () => {
    connectionState = "closed";
    for (const l of stateListeners) l(connectionState, lastEventAt);
  };
  source.onmessage = (msg) => {
    try {
      const parsed = JSON.parse(msg.data) as { at?: number };
      if (typeof parsed.at === "number") {
        lastEventAt = parsed.at;
        for (const l of stateListeners) l(connectionState, lastEventAt);
      }
    } catch {
      /* ignore malformed events */
    }
    for (const l of eventListeners) l();
  };
}

/**
 * Subscribe to watcher events. `onEvent` fires once per SSE message
 * the server sends. The callback identity matters — pass a stable
 * reference (useCallback) so the effect doesn't re-subscribe on every
 * render.
 */
export function useLiveRefreshEvent(onEvent: () => void): void {
  useEffect(() => {
    ensureSource();
    eventListeners.add(onEvent);
    return () => {
      eventListeners.delete(onEvent);
    };
  }, [onEvent]);
}

export function LiveRefresh() {
  const [state, setState] = useState<ConnectionState>(connectionState);
  const [lastAt, setLastAt] = useState<number | null>(lastEventAt);

  useEffect(() => {
    ensureSource();
    const listener = (s: ConnectionState, at: number | null) => {
      setState(s);
      setLastAt(at);
    };
    stateListeners.add(listener);
    return () => {
      stateListeners.delete(listener);
    };
  }, []);

  const dotClass =
    state === "open" ? "dot-ok" : state === "closed" ? "dot-bad" : "dot-warn";
  const tooltip =
    state === "open"
      ? `live · last event: ${lastAt ? new Date(lastAt).toLocaleTimeString() : "—"}`
      : state === "closed"
        ? "disconnected — pages still refresh on navigation"
        : "connecting…";

  return (
    <span title={tooltip} className={`dot ${dotClass}`}>
      <Icon name="live" />
      <span>{state === "open" ? "live" : state}</span>
    </span>
  );
}
