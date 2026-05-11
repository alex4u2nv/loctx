import { Fragment } from "react";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function StatusPage({ refreshKey }: { refreshKey: number }) {
  const { data, error, loading } = useFetch(() => api.status(), [refreshKey]);

  if (loading && data === null) return <p className="pullquote">Loading…</p>;
  if (error !== null) return <ErrorBlock message={error} />;
  if (data === null) return <p className="pullquote">No data.</p>;

  const daemon = data.daemon;
  const daemonFields: ReadonlyArray<readonly [string, string]> = daemon.running
    ? [
        ["status", "running"],
        ["pid", String(daemon.pid)],
        [
          "endpoint",
          daemon.port !== null
            ? `http://${daemon.hostname ?? "localhost"}:${daemon.port}`
            : "(stdio only)",
        ],
        ["started", new Date(daemon.startedAt).toLocaleString()],
        ["version", daemon.version],
      ]
    : [["status", `not running (no PID lock at ${daemon.pidLockPath})`]];

  const runtimeFields: ReadonlyArray<readonly [string, string]> = [
    ["config (global)", data.runtime.configGlobal ?? "(default)"],
    ["config (project)", data.runtime.configProject ?? "(none)"],
    ["data dir", data.runtime.dataDir],
    ["vector dir", data.runtime.vectorDir],
    ["state db", data.runtime.stateDb],
    ["embedding", `${data.runtime.embeddingProvider}/${data.runtime.embeddingModel}`],
    ["retrieval mode", data.runtime.retrievalMode],
    ["watcher debounce", `${data.runtime.watcherDebounceMs}ms`],
    [
      "reconciliation",
      data.runtime.reconciliationIntervalSeconds === 0
        ? "disabled (set reconciliation.interval_seconds > 0 to enable)"
        : `every ${data.runtime.reconciliationIntervalSeconds}s${
            data.runtime.reconciliationRunOnStart ? " + on boot" : ""
          }`,
    ],
  ];

  const baseUrl =
    daemon.running && daemon.port !== null
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
      {!daemon.running ? (
        <p className="pullquote">
          Run <code>loctx start</code> to bring the daemon up.
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
        Discovered projects <span style={{ color: "var(--subtle)" }}>· {data.projects.length}</span>
      </h2>
      {data.projects.length === 0 ? (
        <p className="pullquote">
          No projects found. Set <code>workspace_roots</code> in your config, or
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
            {data.projects.map((project) => (
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
      <h3>HTTP (recommended)</h3>
      <pre className="snippet">{httpMcpSnippet}</pre>
      <h3>Stdio</h3>
      <pre className="snippet">{stdioMcpSnippet}</pre>
    </section>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
      {message}
    </p>
  );
}
