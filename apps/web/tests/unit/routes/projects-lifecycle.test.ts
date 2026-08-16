/**
 * /api/projects/activate + /api/projects/deactivate — the audit
 * (2026-08-06, "Tests") flagged the activation lifecycle (concurrency
 * guard, background index kickoff, abort plumbing) as untested. Runs
 * without a watcher registry — watcher attach/detach has its own
 * service-level tests; here we drive the route contract.
 */

import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProject, type Runtime } from "@loctx/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountProjects } from "../../../server/api/projects.js";
import { registerErrorBoundary } from "../../../server/lib/http-errors.js";
import { createRebuildTracker, type RebuildTracker } from "../../../server/lib/rebuild-tracker.js";
import { fakeConfig, fakeRuntime, postJson } from "../helpers/harness.js";

let root: string;
let demoRoot: string;
let demoId: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "loctx-lifecycle-")));
  demoRoot = join(root, "demo");
  mkdirSync(demoRoot, { recursive: true });
  demoId = makeProject(demoRoot).id;
});

function lifecycleApp(
  parts: Parameters<typeof fakeRuntime>[0] = {},
  options: {
    tracker?: RebuildTracker;
    getRuntime?: () => Promise<Runtime>;
  } = {},
): { app: Hono; tracker: RebuildTracker } {
  const tracker = options.tracker ?? createRebuildTracker();
  const runtime = fakeRuntime(parts);
  const app = new Hono();
  registerErrorBoundary(app);
  mountProjects(
    app,
    fakeConfig({ workspaceRoots: [root] }),
    undefined,
    options.getRuntime ?? (async () => runtime),
    tracker,
  );
  return { app, tracker };
}

describe("POST /api/projects/activate", () => {
  it("400s without a path and 403s outside workspace_roots", async () => {
    const { app } = lifecycleApp();
    expect((await postJson(app, "/api/projects/activate", {})).status).toBe(400);
    expect((await postJson(app, "/api/projects/activate", { path: "/etc" })).status).toBe(403);
  });

  it("persists the active row and queues the initial index pass", async () => {
    const upserts: Array<{ id: string; active: boolean }> = [];
    const { app, tracker } = lifecycleApp({
      state: {
        upsertProjectWithActive: (p: { id: string }, active: boolean) => {
          upserts.push({ id: p.id, active });
        },
      } as Partial<Runtime["state"]>,
    });

    const { status, body } = await postJson(app, "/api/projects/activate", { path: demoRoot });
    expect(status).toBe(200);
    const b = body as { ok: boolean; queuedForIndex: boolean; project: { id: string } };
    expect(b.ok).toBe(true);
    expect(b.queuedForIndex).toBe(true);
    expect(b.project.id).toBe(demoId);
    expect(upserts).toEqual([{ id: demoId, active: true }]);

    // The initial index runs detached but registers with the tracker so
    // the UI's five rebuild surfaces show it (#309-#320); it must settle.
    await vi.waitFor(() => {
      expect(tracker.snapshot().get(demoId)?.status).toBe("done");
    });
  });

  it("409s a concurrent activate for the same project (#191)", async () => {
    // Gate getRuntime so the first request parks mid-handler while
    // holding the `activating` guard; the second must bounce.
    let release: (rt: Runtime) => void = () => undefined;
    const gated = new Promise<Runtime>((resolve) => {
      release = resolve;
    });
    const { app } = lifecycleApp({}, { getRuntime: () => gated });

    const first = postJson(app, "/api/projects/activate", { path: demoRoot });
    // Give the first request a tick to enter the handler and take the guard.
    await new Promise((r) => setTimeout(r, 10));
    const second = await postJson(app, "/api/projects/activate", { path: demoRoot });
    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toContain("already in progress");

    release(fakeRuntime());
    expect((await first).status).toBe(200);
  });
});

describe("POST /api/projects/deactivate", () => {
  it("400s without a path, 404s an unknown project, 200s a known one", async () => {
    const flips: Array<{ id: string; active: boolean }> = [];
    let known = false;
    const { app } = lifecycleApp({
      state: {
        setProjectActive: (id: string, active: boolean) => {
          flips.push({ id, active });
          return known;
        },
      } as Partial<Runtime["state"]>,
    });

    expect((await postJson(app, "/api/projects/deactivate", {})).status).toBe(400);

    expect((await postJson(app, "/api/projects/deactivate", { path: demoRoot })).status).toBe(404);

    known = true;
    const { status, body } = await postJson(app, "/api/projects/deactivate", { path: demoRoot });
    expect(status).toBe(200);
    expect((body as { project: { id: string } }).project.id).toBe(demoId);
    expect(flips).toEqual([
      { id: demoId, active: false },
      { id: demoId, active: false },
    ]);
  });

  it("aborts the in-flight initial index from a prior activate (#217)", async () => {
    let sawAbort = false;
    const { app } = lifecycleApp({
      indexer: {
        indexProject: (async (
          p: { id: string; name: string; root: string },
          opts?: { signal?: AbortSignal },
        ) => {
          // Park until deactivate trips the signal.
          await new Promise<void>((resolve) => {
            opts?.signal?.addEventListener("abort", () => {
              sawAbort = true;
              resolve();
            });
          });
          return {
            project: p,
            indexed: 0,
            skipped: 0,
            failed: 0,
            elapsedSeconds: 0,
            failures: [],
            total: 0,
          };
        }) as unknown as Runtime["indexer"]["indexProject"],
      },
    });

    expect((await postJson(app, "/api/projects/activate", { path: demoRoot })).status).toBe(200);
    expect((await postJson(app, "/api/projects/deactivate", { path: demoRoot })).status).toBe(200);
    await vi.waitFor(() => {
      expect(sawAbort).toBe(true);
    });
  });
});
