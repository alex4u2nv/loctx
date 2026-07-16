/**
 * ProcessFaultTracker (#452) — dedup + rate-limit + counting for the
 * faults the stdio server swallows. Uses an injected clock so the
 * rate-limit window is deterministic.
 */

import { describe, expect, it } from "vitest";
import { ProcessFaultTracker } from "../src/process-faults.js";

describe("ProcessFaultTracker", () => {
  it("logs the first sighting of a signature and counts it", () => {
    const t = new ProcessFaultTracker({ now: () => 0 });
    expect(t.record("unhandledRejection", "boom\n  at x")).toBe(true);
    const snap = t.snapshot();
    expect(snap.total).toBe(1);
    expect(snap.unique).toBe(1);
    expect(snap.recent[0]?.count).toBe(1);
    expect(snap.recent[0]?.signature).toBe("unhandledRejection:boom");
  });

  it("suppresses stderr for duplicates within the rate-limit window but still counts them", () => {
    let clock = 0;
    const t = new ProcessFaultTracker({ now: () => clock, rateLimitMs: 1000 });
    expect(t.record("uncaughtException", "same error")).toBe(true); // first
    clock = 500;
    expect(t.record("uncaughtException", "same error")).toBe(false); // within window
    clock = 999;
    expect(t.record("uncaughtException", "same error")).toBe(false);
    const snap = t.snapshot();
    expect(snap.total).toBe(3); // all counted
    expect(snap.unique).toBe(1);
    expect(snap.recent[0]?.count).toBe(3);
  });

  it("logs again after the rate-limit window elapses", () => {
    let clock = 0;
    const t = new ProcessFaultTracker({ now: () => clock, rateLimitMs: 1000 });
    t.record("uncaughtException", "same");
    clock = 1001;
    expect(t.record("uncaughtException", "same")).toBe(true);
  });

  it("dedupes by first line so differing stack tails collapse to one signature", () => {
    const t = new ProcessFaultTracker({ now: () => 0 });
    t.record("unhandledRejection", "TypeError: x\n  at a.ts:1");
    t.record("unhandledRejection", "TypeError: x\n  at b.ts:99");
    expect(t.snapshot().unique).toBe(1);
    expect(t.snapshot().recent[0]?.count).toBe(2);
  });

  it("tracks distinct signatures separately", () => {
    const t = new ProcessFaultTracker({ now: () => 0 });
    t.record("unhandledRejection", "error A");
    t.record("uncaughtException", "error B");
    const snap = t.snapshot();
    expect(snap.total).toBe(2);
    expect(snap.unique).toBe(2);
  });

  it("evicts the oldest signature past maxSignatures", () => {
    let clock = 0;
    const t = new ProcessFaultTracker({ now: () => clock, maxSignatures: 2 });
    t.record("unhandledRejection", "first");
    clock = 1;
    t.record("unhandledRejection", "second");
    clock = 2;
    t.record("unhandledRejection", "third"); // evicts "first"
    const sigs = t.snapshot().recent.map((e) => e.signature);
    expect(sigs).not.toContain("unhandledRejection:first");
    expect(sigs).toContain("unhandledRejection:third");
    expect(t.snapshot().unique).toBe(2);
  });

  it("snapshot on a fresh tracker is empty", () => {
    const snap = new ProcessFaultTracker().snapshot();
    expect(snap).toMatchObject({ total: 0, unique: 0, lastAt: null, recent: [] });
  });
});
