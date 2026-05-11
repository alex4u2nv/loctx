/**
 * Operational console — equivalent to `loctx index`, `refresh`,
 * `reset {project|index}`, `restart`, `stop` from the browser.
 *
 * Destructive actions go through window.confirm rather than a custom
 * modal — keeps surface tight and matches CLI's --force gate.
 */

import { useState } from "react";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

export function AdminPage() {
  const projects = useFetch(() => api.projects(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string>("");

  const log = (line: string): void =>
    setOutput((prev) => `${prev}${prev ? "\n" : ""}${line}`);

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    log(`▶ ${label}`);
    try {
      const r = await fn();
      log(`✓ ${label}: ${JSON.stringify(r)}`);
    } catch (e) {
      log(`✗ ${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const indexAll = (): Promise<void> => run("index (all)", () => api.index());
  const indexOne = (path: string): Promise<void> =>
    run(`index ${path}`, () => api.index(path));
  const refreshAll = (): Promise<void> => run("refresh", () => api.refresh());
  const resetIndex = (): Promise<void> => {
    if (!window.confirm("Delete ALL local index data (LanceDB + SQLite)? Source files untouched."))
      return Promise.resolve();
    return run("reset index", () => api.resetIndex());
  };
  const resetProject = (path: string): Promise<void> => {
    if (!window.confirm(`Delete index data for ${path}? Source files untouched.`))
      return Promise.resolve();
    return run(`reset project ${path}`, () => api.resetProject(path));
  };
  const stop = (): Promise<void> => {
    if (!window.confirm("Stop the daemon? The UI will lose its server.")) return Promise.resolve();
    return run("stop", () => api.stop());
  };
  const restart = (): Promise<void> => {
    if (!window.confirm("Restart the daemon? Re-launch with `loctx start` after."))
      return Promise.resolve();
    return run("restart", () => api.restart());
  };

  return (
    <section>
      <span className="eyebrow">Operations</span>
      <h1 className="display">Admin</h1>
      <p className="subtitle">
        Trigger CLI operations from the browser. Destructive actions confirm before running.
      </p>

      <h2>Indexing</h2>
      <p>
        <button type="button" className="btn btn-primary" onClick={() => void indexAll()} disabled={busy !== null}>
          index all
        </button>{" "}
        <button type="button" className="btn" onClick={() => void refreshAll()} disabled={busy !== null}>
          refresh (reconcile)
        </button>
      </p>
      {projects.data && projects.data.active.length > 0 ? (
        <table className="data-table">
          <thead>
            <tr>
              <th>project</th>
              <th>root</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            {projects.data.active.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="dim">{p.root}</td>
                <td>
                  <button type="button" className="btn" onClick={() => void indexOne(p.root)} disabled={busy !== null}>
                    index
                  </button>{" "}
                  <button type="button" className="btn" onClick={() => void resetProject(p.root)} disabled={busy !== null}>
                    reset
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <h2>Reset</h2>
      <p>
        <button type="button" className="btn" onClick={() => void resetIndex()} disabled={busy !== null}>
          reset index (all data)
        </button>
      </p>

      <h2>Daemon</h2>
      <p>
        <button type="button" className="btn" onClick={() => void restart()} disabled={busy !== null}>
          restart
        </button>{" "}
        <button type="button" className="btn" onClick={() => void stop()} disabled={busy !== null}>
          stop
        </button>
      </p>

      <h2>Output</h2>
      <pre className="snippet" style={{ whiteSpace: "pre-wrap", minHeight: "8rem" }}>
        {output || "(idle)"}
      </pre>
    </section>
  );
}
