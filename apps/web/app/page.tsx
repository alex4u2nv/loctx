/**
 * Status page — operations console for the loctx daemon (#44).
 *
 * Tells the user, at a glance:
 *   - Is loctx running? (daemon lock + PID/port from the lock file)
 *   - What is it watching? (workspace_roots + active project count)
 *   - What is the embedding model + reconciliation cadence?
 *   - How do I connect an MCP client? (copyable snippets for stdio + HTTP)
 *
 * Stays cheap: uses the admin-context (StateStore + WorkspaceDiscovery + Config)
 * so we never load the embedding model just to render this page.
 */

import { getAdminContext } from "@/lib/admin-context";
import { readActiveDaemon } from "@loctx/core";
import { Fragment } from "react";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function StatusPage() {
  const { config, discovery } = getAdminContext();
  const projects = discovery.discoverProjects();
  const daemon = readActiveDaemon(config.paths.dataDir);

  const runtimeFields: ReadonlyArray<[string, string]> = [
    ["config (global)", config.source ?? "(default)"],
    ["config (project)", config.projectSource ?? "(none)"],
    ["data dir", config.paths.dataDir],
    ["vector dir", config.paths.vectorDir],
    ["state db", config.paths.stateDb],
    ["embedding", `${config.embedding.provider}/${config.embedding.model}`],
    ["retrieval mode", config.retrieval.mode],
    ["watcher debounce", `${config.watcher.debounceMs}ms`],
    [
      "reconciliation",
      config.reconciliation.intervalSeconds === 0
        ? "disabled (set reconciliation.interval_seconds > 0 to enable)"
        : `every ${config.reconciliation.intervalSeconds}s${
            config.reconciliation.runOnStart ? " + on boot" : ""
          }`,
    ],
  ];

  const daemonFields: ReadonlyArray<[string, string]> = daemon
    ? [
        ["status", "running"],
        ["pid", String(daemon.pid)],
        [
          "endpoint",
          daemon.port !== undefined
            ? `http://${daemon.hostname ?? "localhost"}:${daemon.port}`
            : "(stdio only)",
        ],
        ["started", new Date(daemon.startedAt).toLocaleString()],
        ["version", daemon.version],
      ]
    : [["status", `not running (no PID lock at ${config.paths.dataDir}/loctx.pid)`]];

  const baseUrl = daemon?.port
    ? `http://${daemon.hostname ?? "localhost"}:${daemon.port}`
    : "http://localhost:3022";

  const httpMcpSnippet = JSON.stringify(
    { mcpServers: { loctx: { url: `${baseUrl}/mcp` } } },
    null,
    2,
  );
  const stdioMcpSnippet = JSON.stringify(
    { mcpServers: { loctx: { command: "npx", args: ["loctx-mcp"] } } },
    null,
    2,
  );

  return (
    <section>
      <span className="eyebrow">Workspace</span>
      <h1 className="display">Status</h1>
      <p className="subtitle">
        Live view of the loctx daemon — configuration, storage, and the projects currently
        discoverable under <code>workspace_roots</code>.
      </p>

      <h2>Daemon</h2>
      <dl className="kv">
        {daemonFields.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      {!daemon ? (
        <p className="pullquote">
          Run <code>loctx start</code> to bring the daemon up. The watcher and MCP HTTP endpoint
          will follow.
        </p>
      ) : null}

      <h2>Runtime</h2>
      <dl className="kv">
        {runtimeFields.map(([label, value]) => (
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
          No projects found. Either set <code>workspace_roots</code> in{" "}
          <code>{config.source ?? "$XDG_CONFIG_HOME/loctx/config.yaml"}</code>, or
          <code>cd</code> into a directory containing a <code>.git</code> marker and re-run.
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

      <h2>Connect an MCP client</h2>
      <p className="summary">
        loctx exposes the same three search tools (<code>search_workspace</code>,
        <code>workspace_status</code>, <code>find_usages</code>) over either transport. Pick the one
        your agent supports and paste the snippet into its MCP config.
      </p>

      <h3>HTTP (recommended — shared daemon)</h3>
      <pre className="snippet">{httpMcpSnippet}</pre>

      <h3>Stdio (one process per agent)</h3>
      <pre className="snippet">{stdioMcpSnippet}</pre>

      <h2>Verify from the CLI</h2>
      <pre className="snippet">
        {[
          "loctx status      # show config, daemon state, discovered projects",
          "loctx doctor      # health check (storage, embedding, ulimit, reconciliation)",
          "loctx search 'authenticate' --limit 5",
        ].join("\n")}
      </pre>
    </section>
  );
}
