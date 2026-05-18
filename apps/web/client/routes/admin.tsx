/**
 * Daemon-wide operations console. Per-project actions live on /projects;
 * everything here applies to the workspace as a whole.
 */

import { useCallback } from "react";
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
  const onRefresh = useCallback(() => statusReq.reload(), [statusReq.reload]);
  useLiveRefreshEvent(onRefresh);
  const reconcile = statusReq.data?.reconciliation;
  const reconcileBlocked = reconcile?.running ?? false;
  const indexBlocked = ops.busy !== null || reconcileBlocked;
  const reconcileTooltip = reconcileBlocked
    ? `Reconciler is running on ${reconcile?.currentProjectName ?? "—"} — would 409. Wait for the pass to finish.`
    : undefined;

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

      <h2 id="admin-index">Index</h2>
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
          disabled={ops.busy !== null}
        >
          <Icon name="reset" /> reset index (delete all data)
        </button>
      </p>

      <h2 id="admin-daemon">Daemon</h2>
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
      <SectionNav
        sections={[
          { id: "admin-index", label: "Index" },
          { id: "admin-daemon", label: "Daemon" },
        ]}
      />
    </section>
  );
}
