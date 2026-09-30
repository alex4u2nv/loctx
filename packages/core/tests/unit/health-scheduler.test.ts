import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HealthScheduler } from "../../src/analyzers/health-scheduler.js";
import type { Project } from "../../src/models.js";

const demo = { id: "p1", name: "demo", root: "/w/demo" } as Project;
const other = { id: "p2", name: "other", root: "/w/other" } as Project;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("HealthScheduler", () => {
  it("runs once per project after the quiet window, however many events arrive", async () => {
    const runs: string[] = [];
    const s = new HealthScheduler(
      async (p) => {
        runs.push(p.id);
      },
      { quietMs: 100 },
    );
    s.schedule(demo);
    s.schedule(demo);
    s.schedule(other);
    await vi.advanceTimersByTimeAsync(90);
    expect(runs).toEqual([]);
    s.schedule(demo); // resets demo's window
    await vi.advanceTimersByTimeAsync(20);
    expect(runs).toEqual(["p2"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toEqual(["p2", "p1"]);
    expect(s.pending()).toBe(0);
  });

  it("coalesces events during a run into exactly one follow-up run", async () => {
    let release: () => void = () => undefined;
    const runs: string[] = [];
    const s = new HealthScheduler(
      (p) =>
        new Promise<void>((resolve) => {
          runs.push(p.id);
          release = resolve;
        }),
      { quietMs: 10 },
    );
    s.schedule(demo);
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toEqual(["p1"]);
    s.schedule(demo);
    s.schedule(demo);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual(["p1"]); // follow-up waits its own quiet window
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toEqual(["p1", "p1"]);
  });

  it("reports scorer failures through onError and keeps scheduling", async () => {
    const errors: string[] = [];
    let calls = 0;
    const s = new HealthScheduler(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
      { quietMs: 5, onError: (p, e) => errors.push(`${p.id}:${e.message}`) },
    );
    s.schedule(demo);
    await vi.advanceTimersByTimeAsync(5);
    expect(errors).toEqual(["p1:boom"]);
    s.schedule(demo);
    await vi.advanceTimersByTimeAsync(5);
    expect(calls).toBe(2);
  });

  it("dispose drops armed timers and ignores later schedules", async () => {
    const runs: string[] = [];
    const s = new HealthScheduler(
      async (p) => {
        runs.push(p.id);
      },
      { quietMs: 5 },
    );
    s.schedule(demo);
    await s.dispose();
    s.schedule(other);
    await vi.advanceTimersByTimeAsync(50);
    expect(runs).toEqual([]);
    expect(s.pending()).toBe(0);
  });

  it("dispose waits for an in-flight run and drops its follow-up", async () => {
    let release: () => void = () => undefined;
    let finished = false;
    const s = new HealthScheduler(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            finished = true;
            resolve();
          };
        }),
      { quietMs: 5 },
    );
    s.schedule(demo);
    await vi.advanceTimersByTimeAsync(5);
    expect(s.pending()).toBe(1);
    s.schedule(demo); // would normally queue a follow-up
    let disposed = false;
    const disposing = s.dispose().then(() => {
      disposed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(disposed).toBe(false); // still waiting on the run
    release();
    await disposing;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(s.pending()).toBe(0);
  });
});
