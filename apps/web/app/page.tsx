import { WorkspaceDiscovery, loadConfig } from "@loctx/core";

// Server component — runs on the Node runtime; touches the local filesystem
// and config. Force dynamic rendering so we don't cache stale workspace state
// in the framework's static cache.
export const dynamic = "force-dynamic";

export default function StatusPage() {
  const config = loadConfig();
  const projects = new WorkspaceDiscovery(config.workspaceRoots).discoverProjects();

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Workspace status</h1>
      <table cellPadding={6} style={{ borderCollapse: "collapse", marginBottom: 32 }}>
        <tbody>
          {[
            ["config", config.source ?? "(default)"],
            ["data dir", config.paths.dataDir],
            ["chroma dir", config.paths.chromaDir],
            ["state db", config.paths.stateDb],
            ["embedding", `${config.embedding.provider}/${config.embedding.model}`],
          ].map(([label, value]) => (
            <tr key={label} style={{ borderBottom: "1px solid #1f2540" }}>
              <td style={{ color: "#7a85b8", paddingRight: 16 }}>{label}</td>
              <td style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginBottom: 8 }}>Discovered projects ({projects.length})</h2>
      {projects.length === 0 ? (
        <p style={{ color: "#7a85b8" }}>
          No projects found. Configure <code>workspace_roots</code> in{" "}
          <code>$XDG_CONFIG_HOME/loctx/config.yaml</code>.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {projects.map((project) => (
            <li
              key={project.id}
              style={{
                padding: "8px 0",
                borderBottom: "1px solid #1f2540",
                display: "grid",
                gridTemplateColumns: "180px 220px 1fr",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontSize: 14,
              }}
            >
              <code style={{ color: "#7a85b8" }}>{project.id}</code>
              <span>{project.name}</span>
              <span style={{ color: "#9ba3c4" }}>{project.root}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
