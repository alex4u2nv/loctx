/**
 * GET /api/projects/:id/health is read-only (latest snapshot + history,
 * null snapshot until scored); POST .../health/recompute scores,
 * persists, and coalesces concurrent runs. The scorer is injected; the
 * real one is covered by core's tests.
 */

import type { CodeHealth, Runtime } from "@loctx/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountHealth } from "../../../server/api/health.js";
import { registerErrorBoundary } from "../../../server/lib/http-errors.js";
import { fakeRuntime } from "../helpers/harness.js";

const demo = { id: "p1", name: "demo", root: "/w/demo", active: true };
const health = (score: number): CodeHealth => ({
  version: 1,
  score,
  grade: score >= 80 ? "B" : "C",
  dimensions: [],
  basis: { indexedFiles: 3, findings: 0, suppressed: 0, unmappedFindings: 0 },
  notes: [],
});
const snapshot = (score: number, at: string, version = 1) => ({
  projectId: "p1",
  computedAt: at,
  version,
  score,
  grade: "B",
  payloadJson: JSON.stringify(health(score)),
});
type Scored = { health: CodeHealth; computedAt: string; changed: boolean } | null;

function healthApp(
  snapshots: ReturnType<typeof snapshot>[],
  scorer: () => Promise<Scored> = async () => ({
    health: health(91),
    computedAt: "2026-02-01T00:00:00Z",
    changed: true,
  }),
) {
  let scored = 0;
  const runtime = fakeRuntime({
    state: {
      listProjects: () => [demo] as unknown as ReturnType<Runtime["state"]["listProjects"]>,
      listProjectHealth: (_id: string, limit: number) => snapshots.slice(0, limit),
    } as unknown as Partial<Runtime["state"]>,
  });
  const app = new Hono();
  registerErrorBoundary(app);
  mountHealth(app, async () => runtime, {
    score: () => {
      scored += 1;
      return scorer();
    },
  });
  return { app, scoredCalls: () => scored };
}

async function call(app: Hono, url: string, method = "GET") {
  const res = await app.request(url, { method });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/projects/:id/health", () => {
  it("404s an unknown or inactive project", async () => {
    const { app } = healthApp([]);
    expect((await call(app, "/api/projects/nope/health")).status).toBe(404);
  });

  it("serves the latest snapshot and history, never scoring", async () => {
    const { app, scoredCalls } = healthApp([
      snapshot(84, "2026-01-03T00:00:00Z"),
      snapshot(80, "2026-01-01T00:00:00Z"),
    ]);
    const { status, body } = await call(app, "/api/projects/p1/health");
    expect(status).toBe(200);
    const snap = body["snapshot"] as { computedAt: string; health: { score: number } };
    expect(snap.computedAt).toBe("2026-01-03T00:00:00Z");
    expect(snap.health.score).toBe(84);
    expect((body["history"] as Array<{ score: number }>).map((h) => h.score)).toEqual([84, 80]);
    expect(scoredCalls()).toBe(0);
  });

  it("returns a null snapshot when unscored or when the stored row is from another model version", async () => {
    const empty = await call(healthApp([]).app, "/api/projects/p1/health");
    expect(empty.body["snapshot"]).toBeNull();
    const stale = await call(
      healthApp([snapshot(84, "2026-01-03T00:00:00Z", 99)]).app,
      "/api/projects/p1/health",
    );
    expect(stale.body["snapshot"]).toBeNull();
    expect((stale.body["history"] as unknown[]).length).toBe(1);
  });
});

describe("POST /api/projects/:id/health/recompute", () => {
  it("scores, and coalesces concurrent recomputes into one run", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app, scoredCalls } = healthApp([], async () => {
      await gate;
      return { health: health(91), computedAt: "2026-02-01T00:00:00Z", changed: true };
    });
    const a = call(app, "/api/projects/p1/health/recompute", "POST");
    const b = call(app, "/api/projects/p1/health/recompute", "POST");
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(scoredCalls()).toBe(1);
  });

  it("409s a project with nothing indexed", async () => {
    const { app } = healthApp([], async () => null);
    const { status } = await call(app, "/api/projects/p1/health/recompute", "POST");
    expect(status).toBe(409);
  });

  it("404s an unknown project without scoring", async () => {
    const { app, scoredCalls } = healthApp([]);
    expect((await call(app, "/api/projects/nope/health/recompute", "POST")).status).toBe(404);
    expect(scoredCalls()).toBe(0);
  });
});
