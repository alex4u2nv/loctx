"use client";

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
      <span className="dot-mark" />
      <span>{state === "open" ? "live" : state}</span>
    </span>
  );
}
