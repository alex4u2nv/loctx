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
const dataListeners = new Set<(event: unknown) => void>();
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
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(msg.data);
      const candidate = parsed as { at?: number };
      if (typeof candidate.at === "number") {
        lastEventAt = candidate.at;
        for (const l of stateListeners) l(connectionState, lastEventAt);
      }
    } catch {
      /* ignore malformed events — still tick the connection-indicator side below */
      return;
    }
    for (const l of eventListeners) l();
    for (const l of dataListeners) l(parsed);
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

/**
 * Subscribe to the parsed event payload from the module-level
 * EventSource. Use this when you actually need the event fields
 * (kind, projectName, …); `useLiveRefreshEvent` is enough when you
 * just want a refresh tick.
 *
 * Sharing the single module-level connection matters: every separate
 * `new EventSource()` counts toward Chrome's 6-connection per-origin
 * limit and starves later document/API requests when several admin
 * tabs are open (#TODO-issue).
 */
export function useLiveRefreshData<T>(onEvent: (event: T) => void): void {
  useEffect(() => {
    ensureSource();
    const wrapped = (e: unknown): void => onEvent(e as T);
    dataListeners.add(wrapped);
    return () => {
      dataListeners.delete(wrapped);
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
