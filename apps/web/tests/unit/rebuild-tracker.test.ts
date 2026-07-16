/**
 * createRebuildTracker — in-memory per-project rebuild-job state machine
 * behind /api/rebuild progress. Uses the injectable `now` so retention
 * sweeps and progress throttling are deterministic without fake timers.
 */

import { describe, expect, it } from "vitest";
import { createRebuildTracker } from "../../server/lib/rebuild-tracker.js";

describe("createRebuildTracker", () => {
  it("start() returns a running job with zeroed progress", () => {
    const t = createRebuildTracker();
    const job = t.start("p1", "alpha");
    expect(job).toMatchObject({
      projectId: "p1",
      projectName: "alpha",
      status: "running",
      indexed: 0,
      totalFiles: null,
      completedAt: null,
      error: null,
    });
  });

  it("refuses a second concurrent job for the same project (409 path)", () => {
    const t = createRebuildTracker();
    expect(t.start("p1", "alpha")).not.toBeNull();
    expect(t.start("p1", "alpha")).toBeNull();
    // A different project is unaffected.
    expect(t.start("p2", "bravo")).not.toBeNull();
  });

  it("recordProgress updates indexed/total only while running", () => {
    const t = createRebuildTracker();
    t.start("p1", "alpha");
    t.recordProgress("p1", 7, 20);
    expect(t.get("p1")).toMatchObject({ indexed: 7, totalFiles: 20, status: "running" });

    // After finish, late progress is ignored.
    t.finish("p1");
    t.recordProgress("p1", 999, 999);
    expect(t.get("p1")).toMatchObject({ indexed: 7, totalFiles: 20, status: "done" });
  });

  it("recordProgress on an unknown project is a no-op", () => {
    const t = createRebuildTracker();
    expect(() => t.recordProgress("ghost", 1, 1)).not.toThrow();
    expect(t.get("ghost")).toBeNull();
  });

  it("finish() moves a job to done with a completion stamp", () => {
    let clock = 1000;
    const t = createRebuildTracker({ now: () => clock });
    t.start("p1", "alpha");
    clock = 2500;
    t.finish("p1");
    expect(t.get("p1")).toMatchObject({ status: "done", completedAt: 2500, error: null });
  });

  it("fail() moves a job to failed and records the error", () => {
    const t = createRebuildTracker();
    t.start("p1", "alpha");
    t.fail("p1", "embedder crashed");
    expect(t.get("p1")).toMatchObject({ status: "failed", error: "embedder crashed" });
    expect(t.get("p1")?.completedAt).not.toBeNull();
  });

  it("finish/fail on an unknown project are no-ops", () => {
    const t = createRebuildTracker();
    expect(() => t.finish("ghost")).not.toThrow();
    expect(() => t.fail("ghost", "x")).not.toThrow();
  });

  it("re-running a completed project is allowed once its previous job settled", () => {
    const t = createRebuildTracker();
    t.start("p1", "alpha");
    t.finish("p1");
    // Not "running" anymore, so a fresh start succeeds.
    expect(t.start("p1", "alpha")).not.toBeNull();
    expect(t.get("p1")).toMatchObject({ status: "running", indexed: 0 });
  });

  it("sweeps terminal jobs after the retention window elapses", () => {
    let clock = 0;
    const t = createRebuildTracker({ now: () => clock, terminalRetentionMs: 5_000 });
    t.start("p1", "alpha");
    t.finish("p1"); // completedAt = 0
    clock = 4_999;
    expect(t.get("p1")).not.toBeNull(); // within retention
    clock = 5_001;
    expect(t.get("p1")).toBeNull(); // swept
  });

  it("keeps a still-running job regardless of age", () => {
    let clock = 0;
    const t = createRebuildTracker({ now: () => clock, terminalRetentionMs: 1_000 });
    t.start("p1", "alpha");
    clock = 1_000_000;
    // No completedAt → never swept.
    expect(t.get("p1")).toMatchObject({ status: "running" });
  });

  it("snapshot() returns all non-expired jobs keyed by projectId", () => {
    const t = createRebuildTracker();
    t.start("p1", "alpha");
    t.start("p2", "bravo");
    const snap = t.snapshot();
    expect([...snap.keys()].sort()).toEqual(["p1", "p2"]);
    // It's a copy — mutating it doesn't corrupt the tracker.
    snap.delete("p1");
    expect(t.get("p1")).not.toBeNull();
  });
});
