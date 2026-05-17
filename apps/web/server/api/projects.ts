import { homedir } from "node:os";
import {
  type Config,
  type Project,
  type ProjectId,
  type Runtime,
  StateStore,
  type WatcherRegistry,
  WatcherService,
  WorkspaceDiscovery,
  inventoryProjects,
  makeProject,
  resolveUnderWorkspaceRoots,
} from "@loctx/core";
import type { Hono } from "hono";
import type {
  InactiveRow,
  OrphanRow,
  ProjectDetailPayload,
  ProjectHealth,
  ProjectStats,
  ProjectsPayload,
  ProjectsRow,
  RebuildProgress,
  WatcherState,
} from "../../shared/contracts.js";
import type { RebuildJob, RebuildTracker } from "../lib/rebuild-tracker.js";

/**
 * Per-project AbortControllers for the background `indexProject` pass
 * we kick off on activate. Scoped to this module so deactivate can
 * abort the in-flight pass for the same project (#217). Entries clear
 * themselves when the indexer settles.
 */
const inFlightActivation = new Map<string, AbortController>();

/**
 * Project IDs whose `/api/projects/activate` request is currently
 * mid-handler. Two near-simultaneous activate POSTs for the same
 * project would otherwise both pass the `watcherRegistry.get(...) === null`
 * check and attach a second watcher. We hold this guard across the
 * await on the runtime + watcher attach + index kickoff. See #191.
 */
const activating = new Set<string>();

export function mountProjects(
  app: Hono,
  config: Config,
  watcherRegistry: WatcherRegistry | undefined,
  getRuntime: () => Promise<Runtime>,
  rebuildTracker: RebuildTracker,
): void {
  app.get("/api/projects", (c) => {
    const discovery = new WorkspaceDiscovery(config.workspaceRoots);
    const state = new StateStore(config.paths.stateDb);
    try {
      const inventory = inventoryProjects(discovery, state);
      const chunkCounts = chunkCountsByProject(state);
      const rebuilds = rebuildTracker.snapshot();
      // Persisted rebuild intent (survives daemon restart). Lets the
      // UI render "resuming rebuild…" on rows whose rebuild was
      // interrupted, even when the in-memory tracker is empty after
      // a restart. Keyed by projectId for O(1) lookup per row.
      const rebuildPendingByProject = new Map<string, string>(
        state.listProjectsWithRebuildPending().map((p) => [p.id, p.rebuildPendingAt]),
      );

      const buildRow = (
        project: Project,
        lastReconciled: string | null,
        marker: string | null,
        markerKind: string | null,
        isOrphaned = false,
      ): ProjectsRow => {
        const files = state.listFiles(project.id);
        const errors = files.filter((f) => f.error !== null).length;
        const lastIndexed = files
          .map((f) => f.indexedAt)
          .sort()
          .at(-1);
        const watcherEntry =
          watcherRegistry !== undefined ? watcherRegistry.get(project.id as ProjectId) : null;
        const watcherState = watcherEntry !== null ? watcherEntry.state : null;
        const filesCount = files.length;
        const { health, healthHint } = computeHealth({
          isOrphaned,
          watcherState,
          files: filesCount,
          errors,
          lastIndexed: lastIndexed ?? null,
        });
        return {
          id: project.id,
          name: project.name,
          root: project.root,
          marker,
          markerKind,
          files: filesCount,
          chunks: chunkCounts.get(project.id) ?? 0,
          errors,
          lastIndexed: lastIndexed ?? null,
          lastReconciled,
          watcher: watcherState,
          watcherFailure: watcherEntry !== null ? watcherEntry.failureReason : null,
          health,
          healthHint,
          rebuilding: toRebuildProgress(rebuilds.get(project.id)),
          rebuildPendingAt: rebuildPendingByProject.get(project.id) ?? null,
        };
      };

      const active = inventory.active.map((a) =>
        buildRow(a.project, a.lastReconciledAt, a.marker, a.markerKind),
      );
      const inactive: InactiveRow[] = inventory.inactive.map((i) => ({
        id: i.project.id,
        name: i.project.name,
        root: i.project.root,
        marker: i.marker,
        markerKind: i.markerKind,
        known: i.known,
      }));
      const orphaned: OrphanRow[] = inventory.orphaned.map((o) => ({
        ...buildRow(o.project, o.lastReconciledAt, null, null, true),
        reason: o.reason,
        rootExists: o.rootExists,
      }));

      const payload: ProjectsPayload = {
        active,
        inactive,
        orphaned,
        commonRoot: longestCommonPrefix([
          ...active.map((a) => a.root),
          ...inactive.map((i) => i.root),
        ]),
        homeDir: homedir(),
      };
      return c.json(payload);
    } finally {
      state.close();
    }
  });

  app.get("/api/projects/:id", (c) => {
    const id = c.req.param("id");
    const discovery = new WorkspaceDiscovery(config.workspaceRoots);
    const state = new StateStore(config.paths.stateDb);
    try {
      const inventory = inventoryProjects(discovery, state);
      // The inspect view spans active + orphaned. Inactive projects
      // have no indexed content yet, so detail is pointless — surface
      // a 404 and let the UI offer "activate" from the list view.
      const found =
        inventory.active.find((a) => a.project.id === id) ??
        inventory.orphaned.find((o) => o.project.id === id) ??
        null;
      if (found === null) {
        return c.json({ error: "project not found or not yet activated" }, 404);
      }
      const isOrphan = "rootExists" in found;
      const project = found.project;
      const files = state.listFiles(project.id);
      const errors = files.filter((f) => f.error !== null).length;
      const lastIndexed = files
        .map((f) => f.indexedAt)
        .sort()
        .at(-1);
      const watcherEntry =
        watcherRegistry !== undefined ? watcherRegistry.get(project.id) : null;
      const watcherState = watcherEntry !== null ? watcherEntry.state : null;
      const { health, healthHint } = computeHealth({
        isOrphaned: isOrphan,
        watcherState,
        files: files.length,
        errors,
        lastIndexed: lastIndexed ?? null,
      });
      const chunkCounts = chunkCountsByProject(state);
      const rebuild = rebuildTracker.get(project.id);
      const pendingMap = new Map(
        state.listProjectsWithRebuildPending().map((p) => [p.id, p.rebuildPendingAt]),
      );
      const row: ProjectsRow = {
        id: project.id,
        name: project.name,
        root: project.root,
        marker: "marker" in found ? (found.marker as string | null) : null,
        markerKind: "markerKind" in found ? (found.markerKind as string | null) : null,
        files: files.length,
        chunks: chunkCounts.get(project.id) ?? 0,
        errors,
        lastIndexed: lastIndexed ?? null,
        lastReconciled: found.lastReconciledAt ?? null,
        watcher: watcherState,
        watcherFailure: watcherEntry !== null ? watcherEntry.failureReason : null,
        health,
        healthHint,
        rebuilding: toRebuildProgress(rebuild ?? undefined),
        rebuildPendingAt: pendingMap.get(project.id) ?? null,
      };
      const stats = projectStats(state, project.id);
      const payload: ProjectDetailPayload = { project: row, stats };
      return c.json(payload);
    } finally {
      state.close();
    }
  });

  app.post("/api/projects/activate", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
    const path = body?.path?.trim() ?? "";
    if (path === "") return c.json({ error: "path required" }, 400);
    // Confine the resolved path to configured workspace_roots — a local
    // attacker on loopback could otherwise activate `/etc` or another
    // user's home and trigger watcher + indexer work against it.
    const confined = resolveUnderWorkspaceRoots(path, config.workspaceRoots);
    if (confined === null) {
      return c.json({ error: "path is not under any configured workspace_root" }, 403);
    }
    const project = makeProject(confined);
    // De-dupe near-simultaneous activate POSTs for the same project so
    // we don't attach two watchers or kick off two background indexers
    // on top of each other. The guard is released as soon as the
    // synchronous setup finishes; the background indexer is allowed
    // to keep running across the boundary because it carries its own
    // AbortController (see below).
    if (activating.has(project.id)) {
      return c.json(
        { error: "activate already in progress for this project" },
        409,
      );
    }
    activating.add(project.id);
    try {
      const rt = await getRuntime();
      rt.state.upsertProjectWithActive(project, true);

      // Attach a watcher live so the newly-active project gets indexed
      // incrementally without a daemon restart. Idempotent — if a watcher
      // already exists (re-activate after deactivate), we leave it alone.
      if (
        watcherRegistry !== undefined &&
        watcherRegistry.get(project.id as ProjectId) === null
      ) {
        await attachWatcher(project, rt, config, watcherRegistry);
      }

      // Kick off an initial index pass in the background. For a real-world
      // project this can take minutes; awaiting it here would stall the
      // POST until the embedder finishes and the UI would look frozen.
      // Errors land in stderr; the watcher (above) covers live changes in
      // the meantime.
      //
      // Abort plumbing: stash a per-project controller. If the user calls
      // deactivate before this finishes, we trip the signal — the
      // indexer's between-file check sees it and returns early, sparing
      // the remaining files (and embedding work) on a project the user
      // already changed their mind about (#217).
      const previous = inFlightActivation.get(project.id);
      if (previous !== undefined) previous.abort();
      const controller = new AbortController();
      inFlightActivation.set(project.id, controller);
      const indexPass = rt.indexer.indexProject(project, { signal: controller.signal });
      void indexPass
        .catch((err) => {
          console.error(
            `[activate] initial index failed for ${project.name}: ${(err as Error).message}`,
          );
        })
        .finally(() => {
          // Only clear if this controller is still the current one (a
          // racing activate could have replaced it).
          if (inFlightActivation.get(project.id) === controller) {
            inFlightActivation.delete(project.id);
          }
        });
    } finally {
      activating.delete(project.id);
    }

    return c.json({
      ok: true,
      project: { id: project.id, name: project.name, root: project.root },
      queuedForIndex: true,
    });
  });

  app.post("/api/projects/deactivate", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { path?: string } | null;
    const path = body?.path?.trim() ?? "";
    if (path === "") return c.json({ error: "path required" }, 400);
    const confined = resolveUnderWorkspaceRoots(path, config.workspaceRoots);
    if (confined === null) {
      return c.json({ error: "path is not under any configured workspace_root" }, 403);
    }
    const project = makeProject(confined);
    const rt = await getRuntime();
    const ok = rt.state.setProjectActive(project.id, false);
    if (!ok) return c.json({ error: "no such project" }, 404);

    // Abort any in-flight initial index pass kicked off by a prior
    // activate. The indexer checks between files, so this stops further
    // embedding work without leaving a partially-indexed file (#217).
    const pending = inFlightActivation.get(project.id);
    if (pending !== undefined) {
      pending.abort();
      inFlightActivation.delete(project.id);
    }

    // Stop the live watcher so we're not still emitting events for a
    // deactivated project. The state row already flipped, but if the
    // watcher cleanup fails the user has a half-finished operation —
    // surface it as a 500 so they can retry rather than walking away
    // thinking it's done (#202). `stop()` has its own 5s timeout, so
    // the request can't hang on a stuck unsubscribe.
    if (watcherRegistry !== undefined) {
      try {
        await detachWatcher(project.id as ProjectId, watcherRegistry);
      } catch (err) {
        const message = (err as Error).message;
        console.error(`[deactivate] failed to stop watcher for ${project.name}: ${message}`);
        return c.json(
          {
            error: "watcher_stop_failed",
            detail: message,
            project: { id: project.id, name: project.name, root: project.root },
            stateActive: false,
          },
          500,
        );
      }
    }

    return c.json({ ok: true, project: { id: project.id, name: project.name, root: project.root } });
  });
}

async function attachWatcher(
  project: Project,
  rt: Runtime,
  config: Config,
  registry: WatcherRegistry,
): Promise<void> {
  const w = new WatcherService(project, rt.indexer, {
    debounceMs: config.watcher.debounceMs,
    onEvent: (event, relPath) => {
      console.error(`[loctx watch] ${event}\t${project.name}/${relPath}`);
    },
    onError: (event, relPath, err) => {
      console.error(`[watcher] ${event} ${relPath}: ${err.message}`);
      registry.markFailed(project.id, err.message);
    },
  });
  await w.start();
  registry.register({
    projectId: project.id,
    projectName: project.name,
    projectRoot: project.root,
    watcher: w,
    startedAt: new Date().toISOString(),
  });
}

async function detachWatcher(projectId: ProjectId, registry: WatcherRegistry): Promise<void> {
  const entry = registry.get(projectId);
  if (entry === null) return;
  await entry.watcher.stop();
  registry.unregister(projectId);
}

/**
 * Derive a single per-project health signal from the runtime watcher
 * state plus the index inventory. The order matters: failure /
 * orphaned states beat "needs initial index"; "errors" beats "active"
 * so a partially-broken project surfaces.
 */
function computeHealth(input: {
  isOrphaned: boolean;
  watcherState: WatcherState | null;
  files: number;
  errors: number;
  lastIndexed: string | null;
}): { health: ProjectHealth; healthHint: string } {
  if (input.isOrphaned) {
    return {
      health: "orphaned",
      healthHint:
        "no longer under workspace_roots — purge to remove, or restore the path to make active",
    };
  }
  if (input.watcherState === "failed") {
    return {
      health: "failed",
      healthHint: "watcher failed — check logs, then resume to retry",
    };
  }
  if (input.watcherState === "paused") {
    return { health: "paused", healthHint: "watcher paused — resume to track changes" };
  }
  if (input.files === 0 && input.lastIndexed === null) {
    return {
      health: "never-indexed",
      healthHint:
        "watcher only catches changes — click rebuild to populate the index from existing files",
    };
  }
  if (input.files === 0) {
    return {
      health: "empty",
      healthHint: "0 files matched the filter — check .loctxignore / .gitignore / language config",
    };
  }
  if (input.errors > 0) {
    return {
      health: "errors",
      healthHint: `${input.errors} file(s) failed to index — rebuild to retry`,
    };
  }
  if (input.watcherState === "active") {
    return { health: "active", healthHint: "watching + indexed" };
  }
  return {
    health: "ready",
    healthHint: "indexed (no live watcher; daemon was started with --no-watch)",
  };
}

/**
 * Longest directory-segment prefix shared by every path. Returns "" when
 * there are 0/1 paths (no aggregation makes sense) or when the only
 * common segment would be "/" (would falsely strip everything).
 */
function longestCommonPrefix(paths: ReadonlyArray<string>): string {
  if (paths.length < 2) return "";
  const split = paths.map((p) => p.split("/"));
  const minLen = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < minLen && split.every((s) => s[i] === split[0]?.[i])) i += 1;
  if (i <= 1) return "";
  return split[0]!.slice(0, i).join("/");
}

/** Per-project chunk count via one SQL aggregate. */
function toRebuildProgress(job: RebuildJob | undefined): RebuildProgress | null {
  if (job === undefined) return null;
  return {
    status: job.status,
    indexed: job.indexed,
    totalFiles: job.totalFiles,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
  };
}

function projectStats(state: StateStore, projectId: string): ProjectStats {
  // Reach for the raw better-sqlite handle the same way chunkCountsByProject
  // does. The state store doesn't expose these custom aggregates yet —
  // if we end up needing them in other places, promote them to
  // `:name` queries in state.sql.
  type Db = { prepare(sql: string): { all(...args: unknown[]): Array<unknown> } };
  const db = (state as unknown as { db: Db })["db"];

  // One row per indexed file with its chunk count + indexed timestamp.
  // We aggregate byExtension + topFiles + recentFiles from this single
  // pass in JS rather than doing three SQL queries. SQLite has no
  // last-character search primitive (no `reverse()`), and even if it
  // did, doing the extension-extraction in JS is more readable and
  // handles dotfiles + multi-dot names predictably.
  const fileRows = db
    .prepare(
      "SELECT files.rel_path AS rel_path, files.indexed_at AS indexed_at, " +
        "COUNT(chunks.chunk_id) AS chunks " +
        "FROM files LEFT JOIN chunks ON chunks.file_id = files.file_id " +
        "WHERE files.project_id = ? AND files.error IS NULL " +
        "GROUP BY files.file_id",
    )
    .all(projectId) as Array<{ rel_path: string; indexed_at: string | null; chunks: number }>;

  const byExtMap = new Map<string, { files: number; chunks: number }>();
  for (const r of fileRows) {
    const ext = extensionOf(r.rel_path);
    const entry = byExtMap.get(ext) ?? { files: 0, chunks: 0 };
    entry.files += 1;
    entry.chunks += Number(r.chunks);
    byExtMap.set(ext, entry);
  }
  const byExtension = Array.from(byExtMap.entries())
    .map(([ext, v]) => ({ ext, files: v.files, chunks: v.chunks }))
    .sort((a, b) => b.chunks - a.chunks || a.ext.localeCompare(b.ext));

  const TOP_LIMIT = 10;
  const topFiles = [...fileRows]
    .sort((a, b) => Number(b.chunks) - Number(a.chunks) || a.rel_path.localeCompare(b.rel_path))
    .slice(0, TOP_LIMIT)
    .map((r) => ({
      relPath: r.rel_path,
      chunks: Number(r.chunks),
      indexedAt: r.indexed_at,
    }));
  const recentFiles = [...fileRows]
    .sort((a, b) => {
      const aTs = a.indexed_at ?? "";
      const bTs = b.indexed_at ?? "";
      return bTs.localeCompare(aTs) || a.rel_path.localeCompare(b.rel_path);
    })
    .slice(0, TOP_LIMIT)
    .map((r) => ({ relPath: r.rel_path, indexedAt: r.indexed_at }));

  const failingFileRows = db
    .prepare(
      "SELECT rel_path, error FROM files " +
        "WHERE project_id = ? AND error IS NOT NULL " +
        "ORDER BY rel_path",
    )
    .all(projectId) as Array<{ rel_path: string; error: string }>;

  return {
    byExtension,
    topFiles,
    recentFiles,
    failingFiles: failingFileRows.map((r) => ({
      relPath: r.rel_path,
      error: r.error,
    })),
  };
}

function extensionOf(relPath: string): string {
  const lastSlash = relPath.lastIndexOf("/");
  const lastDot = relPath.lastIndexOf(".");
  // A leading dot (".gitignore") or no-dot file ("Dockerfile") both
  // count as "<none>" rather than the whole basename. A dot inside a
  // directory above the filename ("path.to/file") shouldn't count
  // either; require the dot to appear AFTER the last slash.
  if (lastDot <= lastSlash + 1) return "<none>";
  return relPath.slice(lastDot);
}

function chunkCountsByProject(state: StateStore): Map<string, number> {
  const db = (state as unknown as { db: { prepare(sql: string): { all(): Array<unknown> } } })[
    "db"
  ];
  const rows = db
    .prepare(
      "SELECT files.project_id AS project_id, COUNT(chunks.chunk_id) AS n " +
        "FROM chunks INNER JOIN files ON chunks.file_id = files.file_id " +
        "GROUP BY files.project_id",
    )
    .all() as Array<{ project_id: string; n: number }>;
  return new Map(rows.map((r) => [r.project_id, Number(r.n)]));
}
