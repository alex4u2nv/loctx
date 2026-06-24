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
            </button>
          </p>
        </div>

        <AnalyzersCard />

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
          { id: "admin-analyzers", label: "Analyzers" },
          { id: "admin-agents", label: "Agents" },
          { id: "admin-daemon", label: "Daemon" },
        ]}
      />
    </section>
  );
}

// ---- analyzers panel ---------------------------------------------------

/** Config dot-path for each rule-pack tool's rule directories. */
const RULE_DIR_KEY: Partial<Record<string, string>> = {
  semgrep: "analyzers.semgrep.ruleDirs",
  "ast-grep": "analyzers.astGrep.ruleDirs",
};

interface ToolRow {
  readonly name: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly needsRules: boolean;
  readonly ruleDirs: ReadonlyArray<string> | null;
}

function statusBadge(t: ToolRow): { cls: string; warn: boolean; label: string } {
  if (!t.installed) return { cls: "", warn: false, label: "available" };
  if (t.needsRules) return { cls: "", warn: true, label: "installed · needs rule dirs" };
  if (t.enabled) return { cls: "ok", warn: false, label: "installed · enabled" };
  return { cls: "", warn: false, label: "installed · disabled" };
}

/**
 * Unified analyzer admin: one place to install+enable+backfill each tool,
 * set its rule dirs, and reindex — replacing the old split between the
 * Config page (enable/rule_dirs) and a separate Tools install card.
 */
function AnalyzersCard() {
  const req = useFetch(() => api.toolsStatus(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<{ tool: string; ok: boolean; text: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dirEdits, setDirEdits] = useState<Record<string, string>>({});

  const install = async (name: string): Promise<void> => {
    setBusy(name);
    setLog(null);
    setMsg(null);
    try {
      const r = await api.toolsInstall(name);
      setLog({
        tool: name,
        ok: r.ok,
        text: r.ok ? (r.log ?? "(no output)") : r.log ? `${r.error}\n\n${r.log}` : r.error,
      });
      if (r.ok) setMsg(`${name} installed & enabled · backfill enqueued ${r.backfilled}`);
    } finally {
      setBusy(null);
      req.reload();
    }
  };

  const reindex = async (name: string): Promise<void> => {
    setBusy(name);
    setMsg(null);
    try {
      const r = await api.toolsBackfill(name);
      setMsg(r.ok ? `${name} · reindex enqueued ${r.backfilled}` : `${name}: ${r.error}`);
    } catch (e) {
      setMsg(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const saveDirs = async (name: string): Promise<void> => {
    const key = RULE_DIR_KEY[name];
    if (key === undefined) return;
    const dirs = (dirEdits[name] ?? "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy(name);
    setMsg(null);
    try {
      await api.configWrite({ patch: { [key]: dirs } });
      const r = await api.toolsBackfill(name);
      setMsg(
        `${name} · saved ${dirs.length} rule dir(s)${r.ok ? `, reindex enqueued ${r.backfilled}` : ""}`,
      );
      req.reload();
    } catch (e) {
      setMsg(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const tools = (req.data?.tools ?? []) as ReadonlyArray<ToolRow>;
  return (
    <div className="card">
      <p className="card-section-title" id="admin-analyzers">
        Analyzers
      </p>
      <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        Optional code analyzers. <strong>Install &amp; enable</strong> downloads the tool into a
        loctx-managed location (no system changes), turns it on, and backfills your index in one
        step. semgrep and ast-grep also need rule directories before they produce findings.
      </p>
      {tools.map((t) => {
        const badge = statusBadge(t);
        const acting = busy === t.name;
        const dirValue = dirEdits[t.name] ?? (t.ruleDirs ?? []).join(", ");
        return (
          <div
            key={t.name}
            style={{ borderTop: "1px solid var(--border)", padding: "var(--space-3) 0" }}
          >
            <div className="tool-row" style={{ borderTop: "none", padding: 0 }}>
              <span className="metric-value" style={{ minWidth: "6rem", display: "inline-block" }}>
                {t.name}
              </span>
              <span
                className={`daemon-status ${badge.cls}`}
                {...(badge.warn ? { style: { color: "var(--warn)" } } : {})}
              >
                <span className="dot-mark" />
                {badge.label}
              </span>
              <span style={{ marginLeft: "auto" }}>
                {t.installed ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={acting}
                    onClick={() => void reindex(t.name)}
                  >
                    <Icon name="refresh" animate={acting} /> reindex
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={acting}
                    onClick={() => void install(t.name)}
                  >
                    <Icon name="index" /> install &amp; enable
                  </button>
                )}
              </span>
            </div>
            {t.ruleDirs !== null ? (
              <div
                style={{
                  display: "flex",
                  gap: "var(--space-2)",
                  marginTop: "var(--space-2)",
                  alignItems: "center",
                }}
              >
                <input
                  className="input"
                  placeholder="rule dirs (comma-separated absolute paths)"
                  value={dirValue}
                  onChange={(e) => setDirEdits((p) => ({ ...p, [t.name]: e.target.value }))}
                  style={{ fontSize: "0.8125rem" }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={acting}
                  onClick={() => void saveDirs(t.name)}
                  style={{ whiteSpace: "nowrap" }}
                >
                  save &amp; reindex
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
      {busy !== null ? (
        <p className="dim" style={{ marginTop: "var(--space-3)", marginBottom: 0 }}>
          <Icon name="refresh" animate /> working on {busy}… install can take up to a minute (semgrep
          pulls ~60 packages).
        </p>
      ) : null}
      {msg !== null ? (
        <p className="dim" style={{ marginBottom: 0 }}>
          {msg}
        </p>
      ) : null}
      {log !== null ? (
        <details open style={{ marginTop: "var(--space-3)" }}>
          <summary>
            <span className={`daemon-status ${log.ok ? "ok" : "bad"}`}>
              <span className="dot-mark" />
              {log.tool} install {log.ok ? "log" : "failed"}
            </span>{" "}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setLog(null)}
              style={{ marginLeft: "var(--space-2)" }}
            >
              dismiss
            </button>
          </summary>
          <pre className="log-output">{log.text}</pre>
        </details>
      ) : null}
    </div>
  );
}
