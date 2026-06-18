/**
 * Daemon-wide operations console. Per-project actions live on /projects;
 * everything here applies to the workspace as a whole.
 */

import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { confirm } from "../components/confirm";
import { Icon } from "../components/icon";
import { useLiveRefreshEvent } from "../components/live-refresh";
import { SectionNav } from "../components/section-nav";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";
import { useOpRunner } from "../lib/use-op-runner";

export function AdminPage() {
  const ops = useOpRunner();
  // Poll status so we can disable index/refresh while a reconcile
  // is in flight — they'd 409 anyway (#312) and a pre-disabled
  // button + tooltip beats clicking → reading an error toast.
  const statusReq = useFetch(() => api.status(), []);
  const toolsReq = useFetch(() => api.toolsStatus(), []);
  const onRefresh = useCallback(() => {
    statusReq.reload();
    toolsReq.reload();
  }, [statusReq.reload, toolsReq.reload]);
  useLiveRefreshEvent(onRefresh);
  const reconcile = statusReq.data?.reconciliation;
  const reconcileBlocked = reconcile?.running ?? false;
  const indexBlocked = ops.busy !== null || reconcileBlocked;
  const reconcileTooltip = reconcileBlocked
    ? `Reconciler is running on ${reconcile?.currentProjectName ?? "—"} — would 409. Wait for the pass to finish.`
    : undefined;
  // Reset index refuses while the daemon holds the SQLite + LanceDB
  // handles — /api/reset/index returns 409. Pre-disable the button so
  // the user doesn't go through confirm() only to read the same
  // "daemon is running; stop it first" message as a toast.
  const daemonRunning = statusReq.data?.daemon.running ?? false;
  const resetBlocked = ops.busy !== null || daemonRunning;
  const resetTooltip = daemonRunning
    ? "Daemon is running — stop it first (Daemon → stop, below). /api/reset/index would 409."
    : undefined;

  // Install output, shown verbatim in the Tools card so the user can see
  // what happened (pip / fetch / unzip) and why a tool failed — installs
  // used to run silently (#install-logs).
  const [installLog, setInstallLog] = useState<{
    tool: string;
    ok: boolean;
    log: string;
  } | null>(null);
  const installTool = async (name: string): Promise<void> => {
    setInstallLog(null);
    await ops.run(`install ${name}`, async () => {
      const res = await api.toolsInstall(name);
      setInstallLog({
        tool: name,
        ok: res.ok,
        log: res.log ?? (res.ok ? "(no output)" : res.error),
      });
      if (!res.ok) throw new Error(res.error);
      return res;
    });
    toolsReq.reload();
  };

  const indexAll = (): Promise<unknown> => ops.run("index all", () => api.index());
  const refreshAll = (): Promise<unknown> => ops.run("refresh", () => api.refresh());
  const resetIndex = async (): Promise<unknown> => {
    const ok = await confirm({
      title: "Reset index?",
      message:
        "Delete every chunk + vector + file row in the local index. Source files are untouched. The daemon must be stopped first.",
      confirmLabel: "Reset index",
      danger: true,
    });
    if (!ok) return;
    return ops.run("reset index", () => api.resetIndex());
  };
  const restart = async (): Promise<unknown> => {
    const ok = await confirm({
      title: "Restart daemon?",
      message: "Stop the daemon and re-launch it with `loctx start` afterwards.",
      confirmLabel: "Restart",
    });
    if (!ok) return;
    return ops.run("restart", () => api.restart());
  };
  const stop = async (): Promise<unknown> => {
    const ok = await confirm({
      title: "Stop daemon?",
      message: "The UI will lose its server.",
      confirmLabel: "Stop",
      danger: true,
    });
    if (!ok) return;
    return ops.run("stop", () => api.stop());
  };

  return (
    <section>
      <span className="eyebrow">Operations</span>
      <h1 className="display">Admin</h1>
      <p className="subtitle">
        Workspace-wide controls. Per-project actions (pause / rebuild / purge) live on{" "}
        <Link to="/projects">projects</Link>.
      </p>

      {ops.message ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--warn)" }}>
          {ops.message}
        </p>
      ) : null}

      <div className="card-stack">
        <div className="card">
          <p className="card-section-title" id="admin-index">Index</p>
          <p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void indexAll()}
              disabled={indexBlocked}
              title={reconcileTooltip}
            >
              <Icon name="index" /> index all projects
            </button>{" "}
            <button
              type="button"
              className="btn"
              onClick={() => void refreshAll()}
              disabled={indexBlocked}
              title={reconcileTooltip}
            >
              <Icon name="refresh" /> refresh (reconcile drift)
            </button>{" "}
            <button
              type="button"
              className="btn"
              onClick={() => void resetIndex()}
              disabled={resetBlocked}
              title={resetTooltip}
            >
              <Icon name="reset" /> reset index (delete all data)
            </button>
          </p>
        </div>

        <div className="card">
          <p className="card-section-title" id="admin-tools">Tools</p>
          <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            Optional analyzers. loctx installs these into managed locations (no system changes),
            enables them, and backfills your existing index. semgrep and ast-grep also need rule
            dirs set on <Link to="/config">config</Link> before they run.
          </p>
          {(toolsReq.data?.tools ?? []).map((t) => (
            <div key={t.name} className="tool-row">
              <span className="metric-value" style={{ minWidth: "6rem", display: "inline-block" }}>
                {t.name}
              </span>
              <span className={`daemon-status ${t.installed ? "ok" : "bad"}`}>
                <span className="dot-mark" />
                {t.installed
                  ? t.needsRules
                    ? "installed · needs rule dirs"
                    : "installed"
                  : t.enabled
                    ? "enabled, not installed"
                    : "available"}
              </span>{" "}
              {t.installed ? null : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void installTool(t.name)}
                  disabled={ops.busy !== null}
                  style={{ marginLeft: "var(--space-2)" }}
                >
                  <Icon name="index" /> install {t.name}
                </button>
              )}
            </div>
          ))}
          {ops.busy?.startsWith("install ") ? (
            <p className="dim" style={{ marginBottom: 0 }}>
              <Icon name="refresh" animate /> {ops.busy}… this can take up to a minute (semgrep pulls
              ~60 packages).
            </p>
          ) : null}
          {installLog !== null ? (
            <details open style={{ marginTop: "var(--space-3)" }}>
              <summary>
                <span className={`daemon-status ${installLog.ok ? "ok" : "bad"}`}>
                  <span className="dot-mark" />
                  {installLog.tool} install {installLog.ok ? "log" : "failed"}
                </span>{" "}
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => setInstallLog(null)}
                  style={{ marginLeft: "var(--space-2)" }}
                >
                  dismiss
                </button>
              </summary>
              <pre className="log-output">{installLog.log}</pre>
            </details>
          ) : null}
        </div>

        <div className="card">
          <p className="card-section-title" id="admin-daemon">Daemon</p>
          <p>
            <button
              type="button"
              className="btn"
              onClick={() => void restart()}
              disabled={ops.busy !== null}
            >
              <Icon name="refresh" /> restart
            </button>{" "}
            <button
              type="button"
              className="btn"
              onClick={() => void stop()}
              disabled={ops.busy !== null}
            >
              <Icon name="stop" /> stop
            </button>
          </p>
        </div>
      </div>
      <SectionNav
        sections={[
          { id: "admin-index", label: "Index" },
          { id: "admin-tools", label: "Tools" },
          { id: "admin-daemon", label: "Daemon" },
        ]}
      />
    </section>
  );
}
