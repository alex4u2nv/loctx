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
import type { OrphanRow, ProjectsPayload, ProjectsRow } from "../../shared/contracts.js";

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
      ): ProjectsRow => {
        const files = state.listFiles(project.id);
        const errors = files.filter((f) => f.error !== null).length;
        const lastIndexed = files
          .map((f) => f.indexedAt)
          .sort()
          .at(-1);
        const watcherEntry =
          watcherRegistry !== undefined ? watcherRegistry.get(project.id as ProjectId) : null;
        return {
          id: project.id,
          name: project.name,
          root: project.root,
          marker,
          markerKind,
          files: files.length,
          chunks: chunkCounts.get(project.id) ?? 0,
          errors,
          lastIndexed: lastIndexed ?? null,
          lastReconciled,
          watcher: watcherEntry !== null ? watcherEntry.state : null,
          watcherFailure: watcherEntry !== null ? watcherEntry.failureReason : null,
        };
      };

      const active = inventory.active.map((a) =>
        buildRow(a.project, a.lastReconciledAt, a.marker, a.markerKind),
      );
      const orphaned: OrphanRow[] = inventory.orphaned.map((o) => ({
        ...buildRow(o.project, o.lastReconciledAt, null, null),
        reason: o.reason,
        rootExists: o.rootExists,
      }));

      const payload: ProjectsPayload = { active, orphaned };
      return c.json(payload);
    } finally {
      state.close();
    }
  });
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
