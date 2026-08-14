/**
 * Coalescer tests (#526): a backfill's thousands of task completions
 * must reach the bus as a bounded number of batch events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyzerEventCoalescer } from "../../src/watcher/analyzer-events.js";
import type { AnalyzerBusEvent } from "../../src/watcher/bus.js";

describe("AnalyzerEventCoalescer (#526)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces many records into one event per (analyzer, project)", () => {
    const events: AnalyzerBusEvent[] = [];
    const c = new AnalyzerEventCoalescer((e) => events.push(e), 2_000);
    for (let i = 0; i < 500; i += 1) c.record("quality", "p1", "complete");
    for (let i = 0; i < 3; i += 1) c.record("quality", "p1", "failed");
    c.record("lizard", "p1", "complete");
    c.record("quality", "p2", "complete");

    expect(events).toHaveLength(0); // window still open
    vi.advanceTimersByTime(2_000);
    // ONE event per window; batches inside it, one per (analyzer, project).
    expect(events).toHaveLength(1);
    const batches = events[0]?.batches ?? [];
    expect(batches).toHaveLength(3);
    const q1 = batches.find((b) => b.analyzer === "quality" && b.projectId === "p1");
    expect(q1?.completed).toBe(500);
    expect(q1?.failed).toBe(3);
    expect(events[0]?.type).toBe("analyzer");
  });

  it("a throwing listener neither escapes flush nor causes a re-publish", () => {
    const events: AnalyzerBusEvent[] = [];
    let shouldThrow = true;
    const c = new AnalyzerEventCoalescer((e) => {
      if (shouldThrow) throw new Error("listener boom");
      events.push(e);
    }, 2_000);
    c.record("quality", "p1", "complete");
    expect(() => c.flush()).not.toThrow();
    // Delivered-and-thrown batches are cleared, not retried.
    shouldThrow = false;
    c.flush();
    expect(events).toHaveLength(0);
  });

  it("re-arms after a window closes; a quiet flush is a no-op", () => {
    const events: AnalyzerBusEvent[] = [];
    const c = new AnalyzerEventCoalescer((e) => events.push(e), 2_000);
    c.record("quality", "p1", "complete");
    vi.advanceTimersByTime(2_000);
    expect(events).toHaveLength(1);

    c.record("quality", "p1", "complete");
    vi.advanceTimersByTime(2_000);
    expect(events).toHaveLength(2);

    c.flush();
    expect(events).toHaveLength(2);
  });

  it("explicit flush publishes immediately without waiting for the window", () => {
    const events: AnalyzerBusEvent[] = [];
    const c = new AnalyzerEventCoalescer((e) => events.push(e), 2_000);
    c.record("definitions", "p1", "failed");
    c.flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.batches[0]?.failed).toBe(1);
    // The armed timer was cancelled — advancing must not double-publish.
    vi.advanceTimersByTime(5_000);
    expect(events).toHaveLength(1);
  });
});
