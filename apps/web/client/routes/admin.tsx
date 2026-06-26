/**
 * Daemon-wide operations console. Per-project actions live on /projects;
 * everything here applies to the workspace as a whole.
 */

import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { AdminTabs } from "../components/admin-tabs";
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
  const onRefresh = useCallback(() => {
    statusReq.reload();
  }, [statusReq.reload]);
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

  // Result of the last "refresh agent configs" run.
  const [agentMsg, setAgentMsg] = useState<string | null>(null);
  const refreshAgents = async (): Promise<void> => {
    setAgentMsg(null);
    const r = await ops.run("refresh agent configs", () => api.agentSetupRefresh());
    if (r !== undefined) {
      setAgentMsg(
        r.wired === 0
          ? "No wired projects found — set one up from the projects page first."
          : `Re-stamped ${r.wired} wired project(s); ${r.filesWritten} file(s) updated.`,
      );
    }
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
  const [compactMsg, setCompactMsg] = useState<string | null>(null);
  const compact = (): Promise<unknown> =>
    ops.run("compact", async () => {
      setCompactMsg(null);
      const r = await api.compact();
      const gb = (n: number): string => (n / 1e9).toFixed(2);
      setCompactMsg(
        `Reclaimed ${gb(r.freedBytes)} GB — vectors ${gb(r.beforeBytes)} → ${gb(r.afterBytes)} GB.`,
      );
      return r;
    });
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

      <AdminTabs />

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
            </button>{" "}
            <button
              type="button"
              className="btn"
              onClick={() => void compact()}
              disabled={indexBlocked}
              title={reconcileTooltip ?? "Merge vector fragments + prune old version history to reclaim disk"}
            >
              <Icon name="purge" /> compact (reclaim disk)
            </button>
          </p>
          {compactMsg !== null ? (
            <p className="dim" style={{ marginBottom: 0 }}>
              {compactMsg}
            </p>
          ) : null}
        </div>

        <div className="card">
          <p className="card-section-title" id="admin-agents">Agents</p>
          <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            Re-stamp the loctx rules + skill in every already-wired project under your workspace
            roots, propagating the latest usage playbook. Won't wire new projects or change MCP
            transport. Per-project setup lives on <Link to="/projects">projects</Link>.
          </p>
          <p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void refreshAgents()}
              disabled={ops.busy !== null}
            >
              <Icon name="refresh" /> refresh agent configs
            </button>
          </p>
          {agentMsg !== null ? (
            <p className="dim" style={{ marginBottom: 0 }}>
              {agentMsg}
            </p>
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
          { id: "admin-agents", label: "Agents" },
          { id: "admin-daemon", label: "Daemon" },
        ]}
      />
    </section>
  );
}
