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
  summarizeUsage,
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
import { confinedPath } from "../lib/confined-path.js";
import { jsonBody } from "../lib/http-errors.js";
import type { RebuildJob, RebuildTracker } from "../lib/rebuild-tracker.js";

export function mountProjects(
  app: Hono,
  config: Config,
  watcherRegistry: WatcherRegistry | undefined,
  getRuntime: () => Promise<Runtime>,
  rebuildTracker: RebuildTracker,
): void {
  /**
   * Per-project AbortControllers for the background `indexProject` pass
   * we kick off on activate, so deactivate can abort the in-flight pass
   * for the same project (#217). Entries clear themselves when the
   * indexer settles. Closure-scoped (SRV-12): module scope made two
   * mounted apps in one process share activation state and left it
   * unreachable for test reset.
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

  // One SQLite handle + one discovery instance for the lifetime of the
  // server (#455). These were constructed per request, which paid a DB
  // open + (for discovery) a fresh instance on an endpoint the UI polls
  // every 3-8s. Lazy so mounting stays side-effect free; deliberately
  // independent of getRuntime() so /api/projects keeps working during
  // early boot while the runtime (embedding model) is still building.
  let shared: { state: StateStore; discovery: WorkspaceDiscovery } | null = null;
  const getShared = () => {
    shared ??= {
      state: new StateStore(config.paths.stateDb),
      discovery: new WorkspaceDiscovery(config.workspaceRoots),
    };
    return shared;
  };

  app.get("/api/projects", async (c) => {
    const { state, discovery } = getShared();
    // Live reconcile snapshot: lets each row know whether the daemon is
    // currently reconciling it (vs the stale `lastReconciled` stamp).
    // Best-effort — if the runtime isn't ready yet (very early boot)
    // we just leave reconciling=null on every row.
    let reconcileSnap: {
      running: boolean;
      currentProjectId: string | null;
      currentProjectIndexed: number | null;
      currentProjectTotal: number | null;
    } | null = null;
    try {
      const rt = await getRuntime();
      const s = rt.reconciler.status();
      reconcileSnap = {
        running: s.running,
        currentProjectId: s.currentProjectId,
        currentProjectIndexed: s.currentProjectIndexed,
        currentProjectTotal: s.currentProjectTotal,
      };
    } catch {
      // Runtime not ready yet — fall through with reconcileSnap=null.
    }
    {
      const inventory = inventoryProjects(discovery, state);
      const chunkCounts = state.chunkCountsByProject();
      // Files/errors/lastIndexed for every project in one GROUP BY —
      // this endpoint previously loaded every file row per project to
      // derive these three scalars (#455).
      const fileStats = state.fileStatsByProject();
      const rebuilds = rebuildTracker.snapshot();
      // Persisted rebuild intent (survives daemon restart). Lets the
      // UI render "resuming rebuild…" on rows whose rebuild was
      // interrupted, even when the in-memory tracker is empty after
      // a restart. Keyed by projectId for O(1) lookup per row.
      const rebuildPendingByProject = new Map<string, string>(
        state.listProjectsWithRebuildPending().map((p) => [p.id, p.rebuildPendingAt]),
      );

      // Value served per project (#value-metrics): tokens saved, queries,
      // reads avoided. Keyed by projectId for O(1) lookup per row.
      const valueByProject = new Map(
        summarizeUsage(state.readUsageStats()).byProject.map((v) => [
          v.projectId,
          {
            tokensSaved: v.tokensSaved,
            queriesServed: v.queries,
            filesReadAvoided: v.filesReadAvoided,
          },
        ]),
      );

      const buildRow = (
        project: Project,
        lastReconciled: string | null,
        marker: string | null,
        markerKind: string | null,
        isOrphaned = false,
        absorbedMarkers: ProjectsRow["absorbedMarkers"] = [],
      ): ProjectsRow => {
        const stats = fileStats.get(project.id as ProjectId) ?? {
          files: 0,
          errors: 0,
          lastIndexed: null,
        };
        const errors = stats.errors;
        const lastIndexed = stats.lastIndexed ?? undefined;
        const watcherEntry =
          watcherRegistry !== undefined ? watcherRegistry.get(project.id as ProjectId) : null;
        const watcherState = watcherEntry !== null ? watcherEntry.state : null;
        const filesCount = stats.files;
        const rebuildProgress = liveRebuildProgress(
          state,
          project.id,
          toRebuildProgress(rebuilds.get(project.id)),
          rebuildPendingByProject.get(project.id) ?? null,
        );
        const reconciling =
          reconcileSnap !== null &&
          reconcileSnap.running &&
          reconcileSnap.currentProjectId === project.id
            ? {
                indexed: reconcileSnap.currentProjectIndexed,
                total: reconcileSnap.currentProjectTotal,
              }
            : null;
        const { health, healthHint } = computeHealth({
          isOrphaned,
          watcherState,
          files: filesCount,
          errors,
          lastIndexed: lastIndexed ?? null,
          rebuilding:
            rebuildProgress !== null && rebuildProgress.status === "running"
              ? { indexed: rebuildProgress.indexed, totalFiles: rebuildProgress.totalFiles }
              : null,
          reconciling,
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
          rebuilding: rebuildProgress,
          rebuildPendingAt: rebuildPendingByProject.get(project.id) ?? null,
          absorbedMarkers,
          reconciling,
          value: valueByProject.get(project.id) ?? null,
        };
      };

      const active = inventory.active.map((a) =>
        buildRow(
          a.project,
          a.lastReconciledAt,
          a.marker,
          a.markerKind,
          false,
          a.absorbedMarkers.map((m) => ({
            relPath: m.relPath,
            marker: m.marker,
            markerKind: m.markerKind,
          })),
        ),
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
    }
  });

  app.get("/api/projects/:id", async (c) => {
    const id = c.req.param("id");
    const { state, discovery } = getShared();
    let detailReconcileSnap: {
      running: boolean;
      currentProjectId: string | null;
      currentProjectIndexed: number | null;
      currentProjectTotal: number | null;
    } | null = null;
    try {
      const rt = await getRuntime();
      const s = rt.reconciler.status();
      detailReconcileSnap = {
        running: s.running,
        currentProjectId: s.currentProjectId,
        currentProjectIndexed: s.currentProjectIndexed,
        currentProjectTotal: s.currentProjectTotal,
      };
    } catch {
      /* runtime not ready — leave null */
    }
    {
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
      const fileStats = state.fileStatsForProject(project.id);
      const errors = fileStats.errors;
      const lastIndexed = fileStats.lastIndexed ?? undefined;
      const watcherEntry =
        watcherRegistry !== undefined ? watcherRegistry.get(project.id) : null;
      const watcherState = watcherEntry !== null ? watcherEntry.state : null;
      const chunkCounts = state.chunkCountsByProject();
      const rebuild = rebuildTracker.get(project.id);
      const pendingMap = new Map(
        state.listProjectsWithRebuildPending().map((p) => [p.id, p.rebuildPendingAt]),
      );
      const rebuildProgress = liveRebuildProgress(
        state,
        project.id,
        toRebuildProgress(rebuild ?? undefined),
        pendingMap.get(project.id) ?? null,
      );
      const detailReconciling =
        detailReconcileSnap !== null &&
        detailReconcileSnap.running &&
        detailReconcileSnap.currentProjectId === project.id
          ? {
              indexed: detailReconcileSnap.currentProjectIndexed,
              total: detailReconcileSnap.currentProjectTotal,
            }
          : null;
      const { health, healthHint } = computeHealth({
        isOrphaned: isOrphan,
        watcherState,
        files: fileStats.files,
        errors,
        lastIndexed: lastIndexed ?? null,
        rebuilding:
          rebuildProgress !== null && rebuildProgress.status === "running"
            ? { indexed: rebuildProgress.indexed, totalFiles: rebuildProgress.totalFiles }
            : null,
        reconciling: detailReconciling,
      });
      const detailValueSummary = summarizeUsage(state.readUsageStats()).byProject.find(
        (v) => v.projectId === project.id,
      );
      const detailValue =
        detailValueSummary === undefined
          ? null
          : {
              tokensSaved: detailValueSummary.tokensSaved,
              queriesServed: detailValueSummary.queries,
              filesReadAvoided: detailValueSummary.filesReadAvoided,
            };
      const row: ProjectsRow = {
        id: project.id,
        name: project.name,
        root: project.root,
        marker: "marker" in found ? (found.marker as string | null) : null,
        markerKind: "markerKind" in found ? (found.markerKind as string | null) : null,
        files: fileStats.files,
        chunks: chunkCounts.get(project.id) ?? 0,
        errors,
        lastIndexed: lastIndexed ?? null,
        lastReconciled: found.lastReconciledAt ?? null,
        watcher: watcherState,
        watcherFailure: watcherEntry !== null ? watcherEntry.failureReason : null,
        health,
        healthHint,
        rebuilding: rebuildProgress,
        rebuildPendingAt: pendingMap.get(project.id) ?? null,
        absorbedMarkers:
          "absorbedMarkers" in found
            ? found.absorbedMarkers.map((m) => ({
                relPath: m.relPath,
                marker: m.marker,
                markerKind: m.markerKind,
              }))
            : [],
        reconciling:
          detailReconcileSnap !== null &&
          detailReconcileSnap.running &&
          detailReconcileSnap.currentProjectId === project.id
            ? {
                indexed: detailReconcileSnap.currentProjectIndexed,
                total: detailReconcileSnap.currentProjectTotal,
              }
            : null,
        value: detailValue,
      };
      const stats = projectStats(state, project.id);
      const payload: ProjectDetailPayload = { project: row, stats };
      return c.json(payload);
    }
  });

  app.post("/api/projects/activate", async (c) => {
    const body = await jsonBody(c);
    const path = typeof body["path"] === "string" ? body["path"].trim() : "";
    if (path === "") return c.json({ error: "path required" }, 400);
    // Confine the resolved path to configured workspace_roots — a local
    // attacker on loopback could otherwise activate `/etc` or another
    // user's home and trigger watcher + indexer work against it (SRV-4).
    const confined = confinedPath(config, path);
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
      // Register with the RebuildTracker so the five surfaces that
      // consume `row.rebuilding` (#309 table cell, #310 health badge,
      // #311 flow-chart, #317 bell, #320 detail header) all show the
      // in-flight state for activate's initial index pass — same
      // signal a rebuild produces. Without this, activate's
      // background work was invisible. The tracker's null return
      // would only happen if another rebuild was already running for
      // this project, which is mutually exclusive with activate via
      // the `activating` set above.
      const trackerJob = rebuildTracker.start(project.id, project.name);
      const indexPass = rt.indexer.indexProject(project, {
        signal: controller.signal,
        onProgress: ({ indexed, total }) => {
          if (trackerJob !== null) {
            rebuildTracker.recordProgress(project.id, indexed, total);
          }
        },
      });
      void indexPass
        .then(() => {
          if (trackerJob !== null) rebuildTracker.finish(project.id);
        })
        .catch((err) => {
          const msg = (err as Error).message;
          if (trackerJob !== null) rebuildTracker.fail(project.id, msg);
          console.error(`[activate] initial index failed for ${project.name}: ${msg}`);
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
    const body = await jsonBody(c);
    const path = typeof body["path"] === "string" ? body["path"].trim() : "";
    if (path === "") return c.json({ error: "path required" }, 400);
    const confined = confinedPath(config, path);
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
  /** In-flight rebuild progress for this project, if any. */
  rebuilding?: { indexed: number; totalFiles: number | null } | null;
  /** Daemon is currently reconciling this specific project. */
  reconciling?: { indexed: number | null; total: number | null } | null;
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
  // In-flight states override the steady ones so the badge mirrors
  // the timestamp column's "indexing/reconciling" copy (#310).
  // Rebuild wins over reconcile when both are true — a forced rebuild
  // is the more aggressive operation and triggers the reconciler as
  // a side-effect.
  if (input.rebuilding != null) {
    const totalLabel =
      input.rebuilding.totalFiles !== null && input.rebuilding.totalFiles !== undefined
        ? ` / ${input.rebuilding.totalFiles}`
        : "";
    return {
      health: "indexing",
      healthHint: `rebuild in flight — ${input.rebuilding.indexed}${totalLabel} files written so far`,
    };
  }
  if (input.reconciling != null) {
    const detail =
      input.reconciling.indexed !== null && input.reconciling.total !== null
        ? `${input.reconciling.indexed.toLocaleString()} / ${input.reconciling.total.toLocaleString()} files`
        : "walking the project tree";
    return {
      health: "reconciling",
      healthHint: `daemon reconciling this project — ${detail}; results may be partial until done`,
    };
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

/**
 * Reconcile the in-memory tracker job with the persisted "files
 * indexed since the rebuild was queued" count. The tracker isn't
 * updated when the boot reconciler is the one doing the rebuild
 * (it lives in @loctx/core, the tracker lives in apps/web) — so
 * the tracker's `indexed` can lag the real progress badly. We pick
 * whichever count is HIGHER: the tracker (when /api/rebuild is
 * driving) or the actual committed-files count (when the boot
 * reconciler is driving). See #365.
 *
 * Synthesizes a running tracker shape from rebuild_pending_at when
 * the tracker has no job at all — common after a daemon restart
 * resumed an interrupted rebuild from disk.
 */
function liveRebuildProgress(
  state: StateStore,
  projectId: ProjectId,
  trackerProgress: RebuildProgress | null,
  rebuildPendingAt: string | null,
): RebuildProgress | null {
  const committedSincePending =
    rebuildPendingAt !== null ? state.countFilesIndexedSince(projectId, rebuildPendingAt) : 0;

  if (trackerProgress === null) {
    // No tracker job (likely a post-restart resume by the boot reconciler).
    // Synthesize one only while the rebuild is genuinely pending.
    if (rebuildPendingAt === null) return null;
    const startedAt = Date.parse(rebuildPendingAt);
    return {
      status: "running",
      indexed: committedSincePending,
      totalFiles: null,
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      completedAt: null,
      error: null,
    };
  }
  // Tracker exists. Only overwrite `indexed` when the persisted count
  // is HIGHER than what the tracker is reporting. Avoids regressing the
  // displayed number when a successful tracker burst beat the file-
  // commit poll.
  if (trackerProgress.status === "running" && committedSincePending > trackerProgress.indexed) {
    return { ...trackerProgress, indexed: committedSincePending };
  }
  return trackerProgress;
}

function projectStats(state: StateStore, projectId: ProjectId): ProjectStats {
  // One row per indexed file with its chunk count + indexed timestamp.
  // We aggregate byExtension + topFiles + recentFiles from this single
  // pass in JS rather than doing three SQL queries. SQLite has no
  // last-character search primitive (no `reverse()`), and even if it
  // did, doing the extension-extraction in JS is more readable and
  // handles dotfiles + multi-dot names predictably.
  const fileRows = state.listIndexedFilesWithChunks(projectId);

  const byExtMap = new Map<string, { files: number; chunks: number }>();
  for (const r of fileRows) {
    const ext = extensionOf(r.relPath);
    const entry = byExtMap.get(ext) ?? { files: 0, chunks: 0 };
    entry.files += 1;
    entry.chunks += r.chunks;
    byExtMap.set(ext, entry);
  }
  const byExtension = Array.from(byExtMap.entries())
    .map(([ext, v]) => ({ ext, files: v.files, chunks: v.chunks }))
    .sort((a, b) => b.chunks - a.chunks || a.ext.localeCompare(b.ext));

  const TOP_LIMIT = 10;
  const topFiles = [...fileRows]
    .sort((a, b) => b.chunks - a.chunks || a.relPath.localeCompare(b.relPath))
    .slice(0, TOP_LIMIT)
    .map((r) => ({
      relPath: r.relPath,
      chunks: r.chunks,
      indexedAt: r.indexedAt,
    }));
  const recentFiles = [...fileRows]
    .sort((a, b) => {
      const aTs = a.indexedAt ?? "";
      const bTs = b.indexedAt ?? "";
      return bTs.localeCompare(aTs) || a.relPath.localeCompare(b.relPath);
    })
    .slice(0, TOP_LIMIT)
    .map((r) => ({ relPath: r.relPath, indexedAt: r.indexedAt }));

  return {
    byExtension,
    topFiles,
    recentFiles,
    failingFiles: state.listFailingFiles(projectId),
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

