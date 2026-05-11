import { homedir } from "node:os";
import {
  type Config,
  type Project,
  type ProjectId,
  StateStore,
  type WatcherRegistry,
  WorkspaceDiscovery,
  inventoryProjects,
} from "@loctx/core";
import type { Hono } from "hono";
import type {
  OrphanRow,
  ProjectHealth,
  ProjectsPayload,
  ProjectsRow,
  WatcherState,
} from "../../shared/contracts.js";

export function mountProjects(
  app: Hono,
  config: Config,
  watcherRegistry: WatcherRegistry | undefined,
): void {
  app.get("/api/projects", (c) => {
    const discovery = new WorkspaceDiscovery(config.workspaceRoots);
    const state = new StateStore(config.paths.stateDb);
    try {
      const inventory = inventoryProjects(discovery, state);
      const chunkCounts = chunkCountsByProject(state);

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
        };
      };

      const active = inventory.active.map((a) =>
        buildRow(a.project, a.lastReconciledAt, a.marker, a.markerKind),
      );
      const orphaned: OrphanRow[] = inventory.orphaned.map((o) => ({
        ...buildRow(o.project, o.lastReconciledAt, null, null, true),
        reason: o.reason,
        rootExists: o.rootExists,
      }));

      const payload: ProjectsPayload = {
        active,
        orphaned,
        commonRoot: longestCommonPrefix(active.map((a) => a.root)),
        homeDir: homedir(),
      };
      return c.json(payload);
    } finally {
      state.close();
    }
  });
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
        "watcher only catches changes — click recrawl to populate the index from existing files",
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
      healthHint: `${input.errors} file(s) failed to index — recrawl to retry`,
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
