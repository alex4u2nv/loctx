/**
 * Destructive operational endpoints — the audit (2026-08-06, "Tests")
 * flagged that /api/rebuild, /api/reset/*, /api/restart and /api/stop
 * had no unit coverage despite being the routes that wipe data or kill
 * the daemon. Drives the real handlers with a faked Runtime + the real
 * RebuildTracker.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, type Runtime, makeProject } from "@loctx/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountOps } from "../../../server/api/ops.js";
import { registerErrorBoundary } from "../../../server/lib/http-errors.js";
import { createRebuildTracker, type RebuildTracker } from "../../../server/lib/rebuild-tracker.js";
import { fakeConfig, fakeRuntime, postJson } from "../helpers/harness.js";

let root: string;
let demoRoot: string;
let demoId: string;
let dataDir: string;

beforeEach(() => {
  // realpathSync: confinedPath canonicalizes through realpath, and on
  // macOS the tmpdir is a /var → /private/var symlink; project ids hash
  // the canonical root, so the expectation must too.
  root = realpathSync(mkdtempSync(join(tmpdir(), "loctx-ops-")));
  demoRoot = join(root, "demo");
  mkdirSync(demoRoot, { recursive: true });
  demoId = makeProject(demoRoot).id;
  dataDir = join(root, ".data");
  mkdirSync(dataDir, { recursive: true });
});

function opsApp(
  parts: Parameters<typeof fakeRuntime>[0] = {},
  tracker: RebuildTracker = createRebuildTracker(),
): { app: Hono; runtime: Runtime; tracker: RebuildTracker; config: Config } {
  const config = fakeConfig({ workspaceRoots: [root] });
  // Point the daemon-lock read at this test's tmp data dir (default
  // fakeConfig paths are shared constants).
  (config.paths as { dataDir: string }).dataDir = dataDir;
  (config.paths as { vectorDir: string }).vectorDir = join(dataDir, "vectors");
  (config.paths as { stateDb: string }).stateDb = join(dataDir, "state.sqlite3");
  const runtime = fakeRuntime(parts);
  const app = new Hono();
  registerErrorBoundary(app);
  mountOps(app, config, async () => runtime, tracker);
  return { app, runtime, tracker, config };
}

describe("POST /api/rebuild", () => {
  it("202s, wipes, reindexes, and stamps crash-recovery markers in order", async () => {
    const events: string[] = [];
    const { app, tracker } = opsApp({
      state: {
        upsertProjectWithActive: () => events.push("upsert"),
        markProjectRebuildPending: () => events.push("pending"),
        purgeProjectContents: () => events.push("purge"),
        markProjectReconciled: () => events.push("reconciled"),
        clearProjectRebuildPending: () => events.push("clear-pending"),
      } as Partial<Runtime["state"]>,
      vectors: {
        deleteProjectChunks: async () => {
          events.push("delete-vectors");
        },
      } as Partial<Runtime["vectors"]>,
      indexer: {
        indexProject: (async (p: { id: string; name: string; root: string }) => {
          events.push("index");
          return {
            project: p,
            indexed: 1,
            skipped: 0,
            failed: 0,
            elapsedSeconds: 0,
            failures: [],
            total: 1,
          };
        }) as unknown as Runtime["indexer"]["indexProject"],
      },
    });

    const { status, body } = await postJson(app, "/api/rebuild", { path: demoRoot });
    expect(status).toBe(202);
    expect((body as { accepted: Array<{ projectId: string }> }).accepted).toEqual([
      { projectId: demoId, name: "demo" },
    ]);

    // The endpoint enqueues; the destructive pass runs detached. Wait
    // for the tracker to observe completion, then assert the safety
    // ordering: recovery markers BEFORE the wipe, clear AFTER success.
    await vi.waitFor(() => {
      expect(tracker.snapshot().get(demoId)?.status).toBe("done");
    });
    expect(events).toEqual([
      "upsert",
      "pending",
      "delete-vectors",
      "purge",
      "index",
      "reconciled",
      "clear-pending",
    ]);
  });

  it("409s a second rebuild for a project already rebuilding", async () => {
    const tracker = createRebuildTracker();
    tracker.start(demoId, "demo");
    const { app } = opsApp({}, tracker);
    const { status, body } = await postJson(app, "/api/rebuild", { path: demoRoot });
    expect(status).toBe(409);
    const rejected = (body as { rejected: Array<{ reason: string }> }).rejected;
    expect(rejected[0]?.reason).toContain("already in progress");
  });

  it("409s the project the reconciler is currently walking (#207)", async () => {
    const { app } = opsApp({
      reconcile: { running: true, currentProjectId: demoId, currentProjectName: "demo" },
    });
    const { status, body } = await postJson(app, "/api/rebuild", { path: demoRoot });
    expect(status).toBe(409);
    const rejected = (body as { rejected: Array<{ reason: string }> }).rejected;
    expect(rejected[0]?.reason).toContain("reconciler");
  });

  it("403s a path outside every workspace_root", async () => {
    const { app } = opsApp();
    const { status } = await postJson(app, "/api/rebuild", { path: "/etc" });
    expect(status).toBe(403);
  });

  it("with no path, rebuilds ACTIVE projects only", async () => {
    const activeProject = { id: demoId, name: "demo", root: demoRoot };
    const otherRoot = join(root, "other");
    mkdirSync(otherRoot, { recursive: true });
    const inactiveProject = makeProject(otherRoot);
    const { app } = opsApp({
      discovery: {
        discoverWithMarkers: () =>
          [
            { project: activeProject, marker: ".git", markerKind: "git" },
            { project: inactiveProject, marker: ".git", markerKind: "git" },
          ] as unknown as ReturnType<Runtime["discovery"]["discoverWithMarkers"]>,
        findAbsorbedMarkers: () => [],
      } as Partial<Runtime["discovery"]>,
      state: {
        listProjects: () =>
          [
            {
              ...activeProject,
              active: true,
              lastIndexedAt: null,
              lastReconciledAt: null,
            },
          ] as unknown as ReturnType<Runtime["state"]["listProjects"]>,
      } as Partial<Runtime["state"]>,
    });
    const { status, body } = await postJson(app, "/api/rebuild", {});
    expect(status).toBe(202);
    const accepted = (body as { accepted: Array<{ projectId: string }> }).accepted;
    expect(accepted.map((a) => a.projectId)).toEqual([demoId]);
  });
});

describe("reconcile write-guard (#207) on index / refresh / compact", () => {
  const inFlight = {
    reconcile: {
      running: true,
      currentProjectName: "alpha",
      completed: 1,
      total: 3,
    },
  };

  for (const route of ["/api/index", "/api/refresh", "/api/compact"] as const) {
    it(`${route} 409s with live progress while a reconcile runs`, async () => {
      const { app } = opsApp(inFlight);
      const { status, body } = await postJson(app, route, {});
      expect(status).toBe(409);
      const b = body as { error: string; currentProject: string; total: number };
      expect(b.error).toContain("in flight");
      expect(b.currentProject).toBe("alpha");
      expect(b.total).toBe(3);
    });
  }
});

describe("POST /api/reset/project", () => {
  it("400s without a path and 403s outside workspace_roots", async () => {
    const { app } = opsApp();
    expect((await postJson(app, "/api/reset/project", {})).status).toBe(400);
    expect((await postJson(app, "/api/reset/project", { path: "/etc" })).status).toBe(403);
  });

  it("deletes the project's vectors and state rows", async () => {
    const deleted: string[] = [];
    const { app } = opsApp({
      vectors: {
        deleteProjectChunks: async (id: string) => {
          deleted.push(`vectors:${id}`);
        },
      } as Partial<Runtime["vectors"]>,
      state: {
        deleteProject: (id: string) => {
          deleted.push(`state:${id}`);
        },
      } as Partial<Runtime["state"]>,
    });
    const { status, body } = await postJson(app, "/api/reset/project", { path: demoRoot });
    expect(status).toBe(200);
    expect((body as { project: { id: string } }).project.id).toBe(demoId);
    expect(deleted).toEqual([`vectors:${demoId}`, `state:${demoId}`]);
  });
});

describe("POST /api/reset/index", () => {
  it("409s while a live daemon holds the lock", async () => {
    // A lockfile naming THIS test process reads as a live daemon.
    writeFileSync(
      join(dataDir, "loctx.pid"),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        version: "0.0.0-test",
        dataDir,
      }),
    );
    const { app } = opsApp();
    const { status, body } = await postJson(app, "/api/reset/index", {});
    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain("daemon is running");
  });

  it("removes the vector dir and state db when no daemon is running", async () => {
    const { app, config } = opsApp();
    mkdirSync(config.paths.vectorDir, { recursive: true });
    writeFileSync(config.paths.stateDb, "sqlite");
    const { status, body } = await postJson(app, "/api/reset/index", {});
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect(existsSync(config.paths.vectorDir)).toBe(false);
    expect(existsSync(config.paths.stateDb)).toBe(false);
  });
});

describe("POST /api/restart and /api/stop", () => {
  // Only the no-daemon paths: the live path SIGTERMs the lock's pid
  // after 100ms, which must never point at the test process.
  it("409 when no daemon is active", async () => {
    const { app } = opsApp();
    expect((await postJson(app, "/api/restart", {})).status).toBe(409);
    expect((await postJson(app, "/api/stop", {})).status).toBe(409);
  });
});
