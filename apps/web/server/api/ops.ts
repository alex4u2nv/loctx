/**
 * Operational endpoints: index, refresh, reset, restart, stop.
 *
 * Index runs synchronously and returns a per-project summary. The web UI
 * disables the button while the request is in flight rather than
 * streaming progress — keeps the surface tight; revisit if real-time
 * progress is needed.
 *
 * Reset endpoints refuse while a daemon is running, mirroring the CLI
 * (a live runtime holds the SQLite + LanceDB handles open).
 *
 * Restart and stop terminate the calling daemon process. The current
 * page will lose its server; the client must surface a "reconnecting"
 * state and let the user re-launch.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Config,
  type Runtime,
  makeProject,
  readActiveDaemon,
  stopActiveDaemon,
} from "@loctx/core";
import type { Hono } from "hono";

export function mountOps(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
): void {
  app.post("/api/index", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    const rt = await getRuntime();
    const projects = body.path
      ? [rt.discovery.resolveProject(resolve(body.path))].filter((p) => p !== null)
      : rt.discovery.discoverProjects();
    const summaries: Array<{
      projectId: string;
      name: string;
      indexed: number;
      skipped: number;
      failed: number;
      elapsedSeconds: number;
    }> = [];
    for (const project of projects) {
      const summary = await rt.indexer.indexProject(project);
      summaries.push({
        projectId: project.id,
        name: project.name,
        indexed: summary.indexed,
        skipped: summary.skipped,
        failed: summary.failed,
        elapsedSeconds: summary.elapsedSeconds,
      });
    }
    return c.json({ ok: true, summaries });
  });

  app.post("/api/refresh", async (c) => {
    const rt = await getRuntime();
    const projects = rt.discovery.discoverProjects();
    const summaries = await rt.reconciler.reconcileAll(projects);
    return c.json({
      ok: true,
      summaries: summaries.map((s, i) => ({
        projectId: projects[i]?.id ?? "",
        name: projects[i]?.name ?? "",
        pruned: s.pruned,
        reindexed: s.reindexed,
      })),
    });
  });

  app.post("/api/reset/index", (c) => {
    if (readActiveDaemon(config.paths.dataDir) !== null) {
      return c.json({ error: "daemon is running; stop it first" }, 409);
    }
    rmSync(config.paths.vectorDir, { recursive: true, force: true });
    rmSync(config.paths.stateDb, { force: true });
    rmSync(`${config.paths.stateDb}-wal`, { force: true });
    rmSync(`${config.paths.stateDb}-shm`, { force: true });
    return c.json({
      ok: true,
      cleared: [config.paths.vectorDir, config.paths.stateDb],
    });
  });

  app.post("/api/reset/project", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
    const path = body?.path?.trim() ?? "";
    if (path === "") return c.json({ error: "path required" }, 400);

    // We're inside the daemon — use its open Runtime rather than building
    // a second one (which would race on SQLite + LanceDB handles). The
    // CLI's `loctx reset project` retains the file-deletion path for the
    // no-daemon case.
    const rt = await getRuntime();
    const project = makeProject(resolve(path));
    await rt.vectors.deleteProjectChunks(project.id);
    rt.state.deleteProject(project.id);
    return c.json({
      ok: true,
      project: { id: project.id, name: project.name, root: project.root },
    });
  });

  app.post("/api/restart", async (c) => {
    const lock = readActiveDaemon(config.paths.dataDir);
    if (lock === null) return c.json({ error: "no active daemon" }, 409);
    // Caller must re-launch; we just stop. Doing the relaunch from inside
    // the dying process is a known footgun (orphan PIDs on signal races).
    setTimeout(() => {
      void stopActiveDaemon(config.paths.dataDir);
    }, 100);
    return c.json({ ok: true, stopped: lock.pid, message: "daemon stopping; relaunch with `loctx start`" });
  });

  app.post("/api/stop", async (c) => {
    const lock = readActiveDaemon(config.paths.dataDir);
    if (lock === null) return c.json({ error: "no active daemon" }, 409);
    setTimeout(() => {
      void stopActiveDaemon(config.paths.dataDir);
    }, 100);
    return c.json({ ok: true, stopped: lock.pid });
  });
}
