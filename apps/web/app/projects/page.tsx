/**
 * Per-project status — split into:
 *   - **Active**:    project is discoverable under current `workspace_roots`
 *                    and is being watched + re-indexed.
 *   - **Orphaned**:  project rows exist in SQLite + LanceDB but aren't being
 *                    maintained (workspace_roots changed, or the root moved
 *                    on disk). Search still hits these; nothing else does.
 */

import { getAdminContext } from "@/lib/admin-context";
import { type Project, type StateStore, inventoryProjects } from "@loctx/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Project & {
  files: number;
  chunks: number;
  errors: number;
  lastIndexed: string | null;
  lastReconciled: string | null;
  marker: string | null;
  markerKind: string | null;
};

export default function ProjectsPage() {
  const { state, discovery } = getAdminContext();
  const inventory = inventoryProjects(discovery, state);

  // Chunk counts come straight from the chunks table, joined to files by
  // file_id. Cheap one-shot read; runs on every nav, page is force-dynamic.
  const chunkCounts = chunkCountsByProject(state);

  const buildRow = (
    project: Project,
    lastReconciled: string | null,
    marker: string | null,
    markerKind: string | null,
  ): Row => {
    const files = state.listFiles(project.id);
    const errors = files.filter((f) => f.error !== null).length;
    const lastIndexed = files
      .map((f) => f.indexedAt)
      .sort()
      .at(-1);
    return {
      id: project.id,
      name: project.name,
      root: project.root,
      files: files.length,
      chunks: chunkCounts.get(project.id) ?? 0,
      errors,
      lastIndexed: lastIndexed ?? null,
      lastReconciled,
      marker,
      markerKind,
    };
  };

  const activeRows = inventory.active.map((a) =>
    buildRow(a.project, a.lastReconciledAt, a.marker, a.markerKind),
  );
  const orphanedRows = inventory.orphaned.map((o) => ({
    // Orphans no longer have a marker on disk; null is honest.
    ...buildRow(o.project, o.lastReconciledAt, null, null),
    reason: o.reason,
    rootExists: o.rootExists,
  }));

  const totals = activeRows.reduce(
    (acc, row) => ({
      files: acc.files + row.files,
      chunks: acc.chunks + row.chunks,
      errors: acc.errors + row.errors,
    }),
    { files: 0, chunks: 0, errors: 0 },
  );

  return (
    <section>
      <span className="eyebrow">Index</span>
      <h1 className="display">Projects</h1>
      <p className="summary">
        {activeRows.length} active<span className="sep">·</span>
        {totals.files} files indexed<span className="sep">·</span>
        {totals.chunks} chunks<span className="sep">·</span>
        {totals.errors} errors
        {orphanedRows.length > 0 ? (
          <>
            <span className="sep">·</span>
            {orphanedRows.length} orphaned
          </>
        ) : null}
      </p>

      <h2>Active</h2>
      <ProjectsTable
        rows={activeRows}
        emptyMessage="No projects discovered under current workspace_roots."
      />

      {orphanedRows.length > 0 ? (
        <>
          <h2>Orphaned</h2>
          <p className="summary">
            Indexed previously but no longer maintained. Search still returns hits from these
            projects. Run <code>loctx reset project &lt;path&gt;</code> to remove their data, or
            restore <code>workspace_roots</code> to make them active again.
          </p>
          <ProjectsTable rows={orphanedRows} emptyMessage="" showReason />
        </>
      ) : null}
    </section>
  );
}

function ProjectsTable({
  rows,
  emptyMessage,
  showReason,
}: {
  rows: ReadonlyArray<Row & { reason?: string; rootExists?: boolean }>;
  emptyMessage: string;
  showReason?: boolean;
}) {
  const baseCols = 9;
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>id</th>
          <th>name</th>
          <th>root</th>
          <th>marker</th>
          <th className="num">files</th>
          <th className="num">chunks</th>
          <th className="num">errors</th>
          <th>last indexed</th>
          <th>last reconciled</th>
          {showReason ? <th>reason</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="dim">{row.id}</td>
            <td>{row.name}</td>
            <td className={row.rootExists === false ? "err" : "dim"}>{row.root}</td>
            <td className="dim">
              {row.marker !== null
                ? `${row.marker}${row.markerKind !== null ? ` (${row.markerKind})` : ""}`
                : "—"}
            </td>
            <td className="num">{row.files}</td>
            <td className="num">{row.chunks}</td>
            <td className={`num ${row.errors > 0 ? "err" : ""}`}>{row.errors}</td>
            <td className="dim">
              {row.lastIndexed ? new Date(row.lastIndexed).toLocaleString() : "—"}
            </td>
            <td className="dim">
              {row.lastReconciled ? new Date(row.lastReconciled).toLocaleString() : "never"}
            </td>
            {showReason ? (
              <td className={row.rootExists === false ? "err" : "warn"}>{row.reason}</td>
            ) : null}
          </tr>
        ))}
        {rows.length === 0 && emptyMessage !== "" ? (
          <tr>
            <td
              colSpan={showReason ? baseCols + 1 : baseCols}
              style={{ color: "var(--subtle)", textAlign: "center", padding: "var(--space-5)" }}
            >
              {emptyMessage}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

/**
 * Per-project chunk count. One SQL aggregate over `chunks` joined to
 * `files`. Cheap; no migration required since both tables are part of
 * schema_v1.
 */
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
