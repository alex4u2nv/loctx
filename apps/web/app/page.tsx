import { WorkspaceDiscovery, loadConfig } from "@loctx/core";
import { Fragment } from "react";

// Server component — runs on the Node runtime; touches the local filesystem
// and config. Force dynamic rendering so we don't cache stale workspace state
// in the framework's static cache.
export const dynamic = "force-dynamic";

export default function StatusPage() {
  const config = loadConfig();
  const projects = new WorkspaceDiscovery(config.workspaceRoots).discoverProjects();

  const fields: ReadonlyArray<[string, string]> = [
    ["config", config.source ?? "(default)"],
    ["data dir", config.paths.dataDir],
    ["vector dir", config.paths.vectorDir],
    ["state db", config.paths.stateDb],
    ["embedding", `${config.embedding.provider}/${config.embedding.model}`],
  ];

  return (
    <section>
      <span className="eyebrow">Workspace</span>
      <h1 className="display">Status</h1>
      <p className="subtitle">
        Live view of the loctx daemon — configuration, storage, and the projects currently
        discoverable under <code>workspace_roots</code>.
      </p>

      <h2>Runtime</h2>
      <dl className="kv">
        {fields.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>

      <h2>
        Discovered projects <span style={{ color: "var(--subtle)" }}>· {projects.length}</span>
      </h2>
      {projects.length === 0 ? (
        <p className="pullquote">
          No projects found. Set <code>workspace_roots</code> in{" "}
          <code>$XDG_CONFIG_HOME/loctx/config.yaml</code>.
        </p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>id</th>
              <th>name</th>
              <th>root</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id}>
                <td className="dim">{project.id}</td>
                <td>{project.name}</td>
                <td className="dim">{project.root}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
