/**
 * Per-project status — split into:
 *   - **Active**:    project is discoverable under current `workspace_roots`
 *                    and is being watched + re-indexed.
 *   - **Orphaned**:  project rows exist in SQLite + LanceDB but aren't being
 *                    maintained (workspace_roots changed, or the root moved
 *                    on disk). Search still hits these; nothing else does.
 */

import { getAdminContext } from "@/lib/admin-context";
import { inventoryProjects } from "@loctx/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Row {
  id: string;
  name: string;
  root: string;
  files: number;
  errors: number;
  lastIndexed: string | null;
}

export default function ProjectsPage() {
  const { state, discovery } = getAdminContext();
  const inventory = inventoryProjects(discovery, state);

  const buildRow = (project: { id: string; name: string; root: string }): Row => {
    const files = state.listFiles(project.id as Parameters<typeof state.listFiles>[0]);
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
      errors,
      lastIndexed: lastIndexed ?? null,
    };
  };

  const activeRows = inventory.active.map((a) => buildRow(a.project));
  const orphanedRows = inventory.orphaned.map((o) => ({
    ...buildRow(o.project),
    reason: o.reason,
    rootExists: o.rootExists,
  }));

  const totals = activeRows.reduce(
    (acc, row) => ({ files: acc.files + row.files, errors: acc.errors + row.errors }),
    { files: 0, errors: 0 },
  );

  return (
    <section>
      <span className="eyebrow">Index</span>
      <h1 className="display">Projects</h1>
      <p className="summary">
        {activeRows.length} active<span className="sep">·</span>
        {totals.files} files indexed<span className="sep">·</span>
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
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>id</th>
          <th>name</th>
          <th>root</th>
          <th className="num">files</th>
          <th className="num">errors</th>
          <th>last indexed</th>
          {showReason ? <th>reason</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="dim">{row.id}</td>
            <td>{row.name}</td>
            <td className={row.rootExists === false ? "err" : "dim"}>{row.root}</td>
            <td className="num">{row.files}</td>
            <td className={`num ${row.errors > 0 ? "err" : ""}`}>{row.errors}</td>
            <td className="dim">
              {row.lastIndexed ? new Date(row.lastIndexed).toLocaleString() : "—"}
            </td>
            {showReason ? (
              <td className={row.rootExists === false ? "err" : "warn"}>{row.reason}</td>
            ) : null}
          </tr>
        ))}
        {rows.length === 0 && emptyMessage !== "" ? (
          <tr>
            <td
              colSpan={showReason ? 7 : 6}
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
