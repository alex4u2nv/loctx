/**
 * Tests for the background enrichment queue (#61).
 *
 * Asserts:
 *   - dedupe by (id, contentSha, analyzerVersion) — same input never runs twice.
 *   - concurrency caps in-flight runners.
 *   - per-task timeout fires when a runner hangs.
 *   - failures count toward the status snapshot but do not stop the queue.
 *   - onResult sink fires for every completed task, success or failure.
 */

import { describe, expect, it } from "vitest";
import { EnrichmentQueue, type EnrichmentTask } from "../../src/analyzers/queue.js";

function task(
  id: string,
  run: () => Promise<unknown>,
  overrides: Partial<Omit<EnrichmentTask, "id" | "run">> = {},
): EnrichmentTask {
  return {
    id,
    analyzer: "test",
    analyzerVersion: 1,
    contentSha: "sha-abc",
    run,
    ...overrides,
  };
}

describe("EnrichmentQueue", () => {
  it("runs an enqueued task and surfaces the result", async () => {
    const results: string[] = [];
    const q = new EnrichmentQueue({
      onResult: (r) => results.push(`${r.task.id}:${r.status}`),
    });
    expect(q.enqueue(task("t1", async () => "ok"))).toBe(true);
    await q.drainAll();
    expect(results).toEqual(["t1:complete"]);
    const snap = q.status();
    expect(snap.depth).toBe(0);
    expect(snap.completed).toBe(1);
    expect(snap.failures).toBe(0);
    expect(snap.lastRunAt).not.toBeNull();
  });

  it("dedupes identical (id, contentSha, analyzerVersion) submissions", async () => {
    let runs = 0;
    const q = new EnrichmentQueue();
    const t = task("dup", async () => {
      runs += 1;
      return null;
    });
    expect(q.enqueue(t)).toBe(true);
    expect(q.enqueue(t)).toBe(false); // same task in flight or seen
    await q.drainAll();
    expect(q.enqueue(t)).toBe(false); // seen with same hash + version
    await q.drainAll();
    expect(runs).toBe(1);
  });

  it("re-runs the task when contentSha changes (file edited)", async () => {
    let runs = 0;
    const q = new EnrichmentQueue();
    q.enqueue(
      task(
        "x",
        async () => {
          runs += 1;
          return null;
        },
        { contentSha: "v1" },
      ),
    );
    await q.drainAll();
    q.enqueue(
      task(
        "x",
        async () => {
          runs += 1;
          return null;
        },
        { contentSha: "v2" },
      ),
    );
    await q.drainAll();
    expect(runs).toBe(2);
  });

  it("respects the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const q = new EnrichmentQueue({ concurrency: 2 });
    for (let i = 0; i < 6; i += 1) {
      q.enqueue(
        task(`t${i}`, async () => {
          active += 1;
          if (active > peak) peak = active;
          await new Promise((r) => setTimeout(r, 30));
          active -= 1;
        }),
      );
    }
    await q.drainAll();
    expect(peak).toBeLessThanOrEqual(2);
    expect(q.status().completed).toBe(6);
  });

  it("times out a hanging runner and counts the failure", async () => {
    let failureSeen = false;
    const q = new EnrichmentQueue({
      perTaskTimeoutMs: 50,
      onResult: (r) => {
        if (r.status === "failed") failureSeen = true;
      },
    });
    q.enqueue(task("slow", () => new Promise(() => undefined))); // never resolves
    await q.drainAll();
    expect(failureSeen).toBe(true);
    expect(q.status().failures).toBe(1);
  });

  it("surfaces runner exceptions as failed without stopping the queue", async () => {
    const completed: string[] = [];
    const q = new EnrichmentQueue({
      onResult: (r) => completed.push(`${r.task.id}:${r.status}`),
    });
    q.enqueue(
      task("a", async () => {
        throw new Error("boom");
      }),
    );
    q.enqueue(task("b", async () => "ok"));
    await q.drainAll();
    expect(completed).toContain("a:failed");
    expect(completed).toContain("b:complete");
    const snap = q.status();
    expect(snap.failures).toBe(1);
    expect(snap.completed).toBe(1);
  });

  it("invalidate() forces re-run on next enqueue", async () => {
    let runs = 0;
    const q = new EnrichmentQueue();
    q.enqueue(
      task("x", async () => {
        runs += 1;
        return null;
      }),
    );
    await q.drainAll();
    q.invalidate("x");
    q.enqueue(
      task("x", async () => {
        runs += 1;
        return null;
      }),
    );
    await q.drainAll();
    expect(runs).toBe(2);
  });
});
