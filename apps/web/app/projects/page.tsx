/**
 * Per-project status — discovered projects with file counts and last-indexed
 * timestamps from the local SQLite state DB.
 */

import { getAdminContext } from "@/lib/admin-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  const { state, discovery } = getAdminContext();
  const projects = discovery.discoverProjects();

  const rows = projects.map((project) => {
    const files = state.listFiles(project.id);
    const errors = files.filter((f) => f.error !== null).length;
    const lastIndexed = files
      .map((f) => f.indexedAt)
      .sort()
      .at(-1);
    return {
      project,
      files: files.length,
      errors,
      lastIndexed: lastIndexed ?? null,
    };
  });

  const totals = rows.reduce(
    (acc, row) => ({
      files: acc.files + row.files,
      errors: acc.errors + row.errors,
    }),
    { files: 0, errors: 0 },
  );

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Projects</h1>
      <p style={{ color: "#7a85b8", marginTop: 0 }}>
        {projects.length} discovered · {totals.files} files indexed · {totals.errors} errors
      </p>

      <table
        cellPadding={8}
        style={{
          borderCollapse: "collapse",
          width: "100%",
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ borderBottom: "1px solid #1f2540", textAlign: "left", color: "#7a85b8" }}>
            <th>id</th>
            <th>name</th>
            <th>root</th>
            <th style={{ textAlign: "right" }}>files</th>
            <th style={{ textAlign: "right" }}>errors</th>
            <th>last indexed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ project, files, errors, lastIndexed }) => (
            <tr key={project.id} style={{ borderBottom: "1px solid #1f2540" }}>
              <td style={{ color: "#7a85b8" }}>{project.id}</td>
              <td>{project.name}</td>
              <td style={{ color: "#9ba3c4" }}>{project.root}</td>
              <td style={{ textAlign: "right" }}>{files}</td>
              <td style={{ textAlign: "right", color: errors > 0 ? "#ff9b9b" : undefined }}>
                {errors}
              </td>
              <td style={{ color: "#9ba3c4" }}>
                {lastIndexed ? new Date(lastIndexed).toLocaleString() : "—"}
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ color: "#7a85b8", padding: 16, textAlign: "center" }}>
                No projects discovered. Configure <code>workspace_roots</code> in
                <code> ~/.config/loctx/config.yaml</code>.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
