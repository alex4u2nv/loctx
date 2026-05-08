"use client";

/**
 * Subscribes to /api/events (SSE) and calls router.refresh() on each watcher
 * event so the surrounding server component re-renders with fresh
 * StateStore data. Renders a tiny status dot so users see when the live
 * connection is open vs. disconnected.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type ConnectionState = "connecting" | "open" | "closed";

export function LiveRefresh() {
  const router = useRouter();
  const [state, setState] = useState<ConnectionState>("connecting");
  const [lastAt, setLastAt] = useState<number | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setState("open");
    source.onerror = () => setState("closed");
    source.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as { at?: number };
        if (typeof parsed.at === "number") setLastAt(parsed.at);
      } catch {
        /* ignore malformed events */
      }
      router.refresh();
    };
    return () => source.close();
  }, [router]);

  const color = state === "open" ? "#7af0a0" : state === "closed" ? "#ff9b9b" : "#ffd97a";
  const tooltip =
    state === "open"
      ? `live · last event: ${lastAt ? new Date(lastAt).toLocaleTimeString() : "—"}`
      : state === "closed"
        ? "disconnected — pages still refresh on navigation"
        : "connecting…";

  return (
    <span
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "#7a85b8",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: color,
          boxShadow: `0 0 6px ${color}`,
        }}
      />
      <span>{state === "open" ? "live" : state}</span>
    </span>
  );
}
