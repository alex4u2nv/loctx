import type { OrphanRow, ProjectsRow } from "@shared/contracts";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function ProjectsPage({ refreshKey }: { refreshKey: number }) {
  const { data, error, loading } = useFetch(() => api.projects(), [refreshKey]);

  if (loading && data === null) return <p className="pullquote">Loading…</p>;
  if (error !== null)
    return (
      <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
        {error}
      </p>
    );
  if (data === null) return <p className="pullquote">No data.</p>;

  const totals = data.active.reduce(
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
        {data.active.length} active<span className="sep">·</span>
        {totals.files} files indexed<span className="sep">·</span>
        {totals.chunks} chunks<span className="sep">·</span>
        {totals.errors} errors
        {data.orphaned.length > 0 ? (
          <>
            <span className="sep">·</span>
            {data.orphaned.length} orphaned
          </>
        ) : null}
      </p>

      <h2>Active</h2>
      <ProjectsTable
        rows={data.active}
        emptyMessage="No projects discovered under current workspace_roots."
      />

      {data.orphaned.length > 0 ? (
        <>
          <h2>Orphaned</h2>
          <p className="summary">
            Indexed previously but no longer maintained. Run <code>loctx reset project &lt;path&gt;</code> to remove their data, or restore <code>workspace_roots</code> to make them active again.
          </p>
          <ProjectsTable rows={data.orphaned} emptyMessage="" showReason />
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
  rows: ReadonlyArray<ProjectsRow | OrphanRow>;
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
        {rows.map((row) => {
          const orphan = "rootExists" in row ? row : null;
          return (
            <tr key={row.id}>
              <td className="dim">{row.id}</td>
              <td>{row.name}</td>
              <td className={orphan?.rootExists === false ? "err" : "dim"}>{row.root}</td>
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
              {showReason && orphan ? (
                <td className={orphan.rootExists === false ? "err" : "warn"}>{orphan.reason}</td>
              ) : null}
            </tr>
          );
        })}
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
