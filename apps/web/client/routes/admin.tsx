/**
 * Daemon-wide operations console. Per-project actions live on /projects;
 * everything here applies to the workspace as a whole.
 */

import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useOpRunner } from "../lib/use-op-runner";

export function AdminPage() {
  const ops = useOpRunner();

  const indexAll = (): Promise<unknown> => ops.run("index all", () => api.index());
  const refreshAll = (): Promise<unknown> => ops.run("refresh", () => api.refresh());
  const resetIndex = (): Promise<unknown> => {
    if (
      !window.confirm(
        "Delete every chunk + vector + file row in the local index? Source files untouched. The daemon must be stopped first.",
      )
    )
      return Promise.resolve();
    return ops.run("reset index", () => api.resetIndex());
  };
  const restart = (): Promise<unknown> => {
    if (!window.confirm("Stop the daemon? Re-launch it with `loctx start` afterwards.")) {
      return Promise.resolve();
    }
    return ops.run("restart", () => api.restart());
  };
  const stop = (): Promise<unknown> => {
    if (!window.confirm("Stop the daemon? The UI will lose its server.")) return Promise.resolve();
    return ops.run("stop", () => api.stop());
  };

  return (
    <section>
      <span className="eyebrow">Operations</span>
      <h1 className="display">Admin</h1>
      <p className="subtitle">
        Workspace-wide controls. Per-project actions (pause / recrawl / purge) live on{" "}
        <Link to="/projects">projects</Link>.
      </p>

      {ops.message ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--warn)" }}>
          {ops.message}
        </p>
      ) : null}

      <h2>Index</h2>
      <p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void indexAll()}
          disabled={ops.busy !== null}
        >
          index all projects
        </button>{" "}
        <button
          type="button"
          className="btn"
          onClick={() => void refreshAll()}
          disabled={ops.busy !== null}
        >
          refresh (reconcile drift)
        </button>{" "}
        <button
          type="button"
          className="btn"
          onClick={() => void resetIndex()}
          disabled={ops.busy !== null}
        >
          reset index (delete all data)
        </button>
      </p>

      <h2>Daemon</h2>
      <p>
        <button
          type="button"
          className="btn"
          onClick={() => void restart()}
          disabled={ops.busy !== null}
        >
          restart
        </button>{" "}
        <button
          type="button"
          className="btn"
          onClick={() => void stop()}
          disabled={ops.busy !== null}
        >
          stop
        </button>
      </p>
    </section>
  );
}
