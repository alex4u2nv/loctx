/**
 * Operational endpoints: index, rebuild, refresh, reset, restart, stop.
 *
 * Index runs synchronously and returns a per-project summary. The web UI
 * disables the button while the request is in flight rather than
 * streaming progress — keeps the surface tight; revisit if real-time
 * progress is needed.
 *
 * Rebuild is the destructive sibling of index: it clears the project's
 * vectors + SQLite rows first, then re-indexes from scratch. This is
 * the only path that triggers analyzer enrichment (lizard, duplicates,
 * semgrep, ast-grep) for already-indexed files — `indexProject` alone
 * content-sha-skips unchanged files and never fires `afterFileIndexed`.
 *
 * Rebuild is **async**: the endpoint returns 202 immediately and runs
 * the indexer in the background. Progress is surfaced via the
 * RebuildTracker, which feeds /api/projects (per-row state) and the SSE
 * event bus (so the UI can refresh without polling). A synchronous
 * endpoint here would lock the connection for minutes on a CPU-only
 * embedder and the page would look hung.
 *
 * Reset endpoints refuse while a daemon is running, mirroring the CLI
 * (a live runtime holds the SQLite + LanceDB handles open).
 *
 * Restart and stop terminate the calling daemon process. The current
 * page will lose its server; the client must surface a "reconnecting"
 * state and let the user re-launch.
 */

import { rmSync } from "node:fs";
import {
  type Config,
  type Runtime,
  makeProject,
  readActiveDaemon,
  resolveUnderWorkspaceRoots,
  stopActiveDaemon,
} from "@loctx/core";
import type { Hono } from "hono";
import type { RebuildTracker } from "../lib/rebuild-tracker.js";

export function mountOps(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
  rebuildTracker: RebuildTracker,
): void {
  app.post("/api/index", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    const rt = await getRuntime();
    // Same reasoning as /api/refresh below: a concurrent indexer pass
    // against a project the reconciler is also walking races on the
    // same LanceDB table (#207). Refuse and surface what's in flight.
    const status = rt.reconciler.status();
    if (status.running) {
      return c.json(
        {
          error: "a reconcile is already in flight; index would race the in-flight pass",
          currentProject: status.currentProjectName,
          completed: status.completed,
          total: status.total,
        },
        409,
      );
    }
    let projects: ReturnType<typeof rt.discovery.discoverProjects>;
    if (body.path) {
      const confined = resolveUnderWorkspaceRoots(body.path, config.workspaceRoots);
      if (confined === null) {
        return c.json({ error: "path is not under any configured workspace_root" }, 403);
      }
      const resolved = rt.discovery.resolveProject(confined);
      projects = resolved !== null ? [resolved] : [];
    } else {
      projects = rt.discovery.discoverProjects();
    }
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
    // Refuse a second concurrent reconcileAll. The Reconciler's
    // reconcileProject path uses LanceDB writers that aren't safe
    // for concurrent writers within a project (#207) — a click
    // during the startup pass would race the in-flight indexer.
    // Return 409 with the live progress so the caller knows why
    // and what to wait on.
    const status = rt.reconciler.status();
    if (status.running) {
      return c.json(
        {
          error: "a reconcile is already in flight",
          currentProject: status.currentProjectName,
          completed: status.completed,
          total: status.total,
          currentProjectIndexed: status.currentProjectIndexed,
          currentProjectTotal: status.currentProjectTotal,
        },
        409,
      );
    }
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

    const confined = resolveUnderWorkspaceRoots(path, config.workspaceRoots);
    if (confined === null) {
      return c.json({ error: "path is not under any configured workspace_root" }, 403);
    }

    // We're inside the daemon — use its open Runtime rather than building
    // a second one (which would race on SQLite + LanceDB handles). The
    // CLI `loctx purge` retains a file-deletion path for the no-daemon case.
    const rt = await getRuntime();
    const project = makeProject(confined);
    await rt.vectors.deleteProjectChunks(project.id);
    rt.state.deleteProject(project.id);
    return c.json({
      ok: true,
      project: { id: project.id, name: project.name, root: project.root },
    });
  });

  app.post("/api/rebuild", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    const rt = await getRuntime();
    let projects: ReturnType<typeof rt.discovery.discoverProjects>;
    if (body.path !== undefined && body.path.trim() !== "") {
      const confined = resolveUnderWorkspaceRoots(body.path, config.workspaceRoots);
      if (confined === null) {
        return c.json({ error: "path is not under any configured workspace_root" }, 403);
      }
      const resolved = rt.discovery.resolveProject(confined);
      // Fall back to a synthetic Project if discovery didn't find it
      // (orphaned, or never registered) — we still want to be able to
      // wipe its stored data on disk.
      projects = resolved !== null ? [resolved] : [makeProject(confined)];
    } else {
      projects = rt.discovery.discoverProjects();
    }

    // Claim a tracker slot per project before kicking work off. A second
    // /api/rebuild for the same project while one is running gets 409 —
    // wiping vectors twice would race the in-flight indexer's mergeInsert.
    // Also reject if the reconciler is currently walking this exact
    // project: deleteProjectChunks would race the reconciler's writes
    // on the same LanceDB table. Different projects in the same call
    // are fine (the reconciler is sequential).
    const reconcileStatus = rt.reconciler.status();
    const reconcilingProjectId =
      reconcileStatus.running ? reconcileStatus.currentProjectId : null;
    const accepted: Array<{ projectId: string; name: string }> = [];
    const rejected: Array<{ projectId: string; name: string; reason: string }> = [];
    for (const project of projects) {
      if (reconcilingProjectId === project.id) {
        rejected.push({
          projectId: project.id,
          name: project.name,
          reason:
            "reconciler is currently walking this project — wait for it to finish (visible on the bell + /projects)",
        });
        continue;
      }
      const job = rebuildTracker.start(project.id, project.name);
      if (job === null) {
        rejected.push({
          projectId: project.id,
          name: project.name,
          reason: "rebuild already in progress for this project",
        });
        continue;
      }
      accepted.push({ projectId: project.id, name: project.name });
    }

    // Fire background work per accepted project. We deliberately don't
    // await — the endpoint's job is to enqueue, not to drive the
    // embedder to completion. Errors land on the tracker entry (visible
    // via /api/projects) and on stderr.
    for (const project of projects) {
      if (!accepted.some((a) => a.projectId === project.id)) continue;
      // Persist the rebuild intent BEFORE the destructive purge so a
      // daemon crash mid-operation leaves a recoverable marker. The
      // next `loctx start` reads this and resumes the rebuild with
      // priority over other projects' reconciles.
      rt.state.upsertProjectWithActive(project, true);
      rt.state.markProjectRebuildPending(project.id);
      void (async () => {
        try {
          await rt.vectors.deleteProjectChunks(project.id);
          // Keep the project row (with active=1 + rebuild_pending_at)
          // alive so a crash leaves us recoverable. Only the file /
          // chunk / symbol-ref rows get wiped.
          rt.state.purgeProjectContents(project.id);
          await rt.indexer.indexProject(project, {
            onProgress: ({ indexed, total }) => {
              rebuildTracker.recordProgress(project.id, indexed, total);
            },
          });
          // A rebuild does a full walk + write of every file in the
          // project, which is a strict superset of what the reconciler
          // does (prune-deleted + content-sha walk). Stamping
          // last_reconciled_at here keeps doctor + the projects page from
          // showing a stale "reconciled —" right after a clean rebuild.
          rt.state.markProjectReconciled(project.id);
          rt.state.clearProjectRebuildPending(project.id);
          rebuildTracker.finish(project.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          rebuildTracker.fail(project.id, message);
          console.error(`[rebuild] ${project.name} (${project.id}) failed: ${message}`);
        }
      })();
    }

    return c.json(
      {
        ok: true,
        accepted,
        ...(rejected.length > 0 ? { rejected } : {}),
      },
      accepted.length === 0 && rejected.length > 0 ? 409 : 202,
    );
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
