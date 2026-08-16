/**
 * Per-project "connect your editor" dialog. Lists the coding agents loctx
 * can wire up for this project (project-scoped MCP registration + usage
 * rules), pre-checks the ones detected-but-not-connected, and applies the
 * selection via /api/agent-setup. Surfaced from the projects page when a
 * project is enabled.
 */

import type { AgentPlanStatus } from "@shared/contracts";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";
import { AsyncError, AsyncLoading } from "./async-boundary";
import { Banner } from "./banner";
import { Icon } from "./icon";
import { Modal } from "./modal";

export function ConnectEditorModal({
  projectRoot,
  projectName,
  onClose,
}: {
  projectRoot: string;
  projectName: string;
  onClose: () => void;
}) {
  const req = useFetch(() => api.agentSetup(projectRoot), [projectRoot]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Pre-select agents that are present but not yet wired to loctx.
  useEffect(() => {
    if (req.data !== null) {
      setSelected(
        new Set(req.data.agents.filter((a) => a.present && !a.registered).map((a) => a.id)),
      );
    }
  }, [req.data]);

  const toggle = (id: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = async (): Promise<void> => {
    setApplying(true);
    setMessage(null);
    try {
      const res = await api.agentSetupApply(projectRoot, [...selected]);
      const wrote = res.results.filter((r) => r.ok && r.action !== "skip").length;
      const failed = res.results.filter((r) => !r.ok).length;
      setMessage(
        failed > 0
          ? `Wrote ${wrote} file(s); ${failed} failed.`
          : `Wrote ${wrote} file(s). Reload your editor's MCP servers (or restart it) to pick up loctx.`,
      );
      req.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal title={`Connect editors — ${projectName}`} onClose={onClose} maxWidth="660px">
      <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        Write project-scoped MCP registration + usage rules so your coding agents use loctx for this
        project. Non-destructive — merges JSON, updates only loctx-marked blocks.
      </p>

      {req.loading && req.data === null ? <AsyncLoading /> : null}
      {req.error !== null ? <AsyncError error={req.error} /> : null}

      {req.data !== null
        ? req.data.agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              checked={selected.has(a.id)}
              onToggle={() => toggle(a.id)}
            />
          ))
        : null}

      {message !== null ? (
        <Banner tone="warn" soft>
          {message}
        </Banner>
      ) : null}

      <p style={{ marginBottom: 0 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={applying || selected.size === 0}
          onClick={() => void apply()}
        >
          <Icon name="index" /> {applying ? "writing…" : `connect ${selected.size} agent(s)`}
        </button>{" "}
        <button type="button" className="btn" onClick={onClose}>
          close
        </button>
      </p>
    </Modal>
  );
}

function AgentRow({
  agent,
  checked,
  onToggle,
}: {
  agent: AgentPlanStatus;
  checked: boolean;
  onToggle: () => void;
}) {
  const status = agent.registered ? "connected" : agent.present ? "detected" : "not detected";
  const cls = agent.registered ? "ok" : agent.present ? "warn" : "dim";
  return (
    <div className="tool-row" style={{ alignItems: "flex-start", flexDirection: "column" }}>
      <label
        style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", cursor: "pointer" }}
      >
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="metric-value" style={{ minWidth: "11rem" }}>
          {agent.label}
        </span>
        <span className={`daemon-status ${cls === "ok" ? "ok" : "bad"}`}>
          <span className="dot-mark" />
          {status}
        </span>
      </label>
      <div className="dim" style={{ fontSize: "0.75rem", marginLeft: "1.7rem" }}>
        {agent.targets.map((t) => (
          <div key={t.path}>
            <code>{t.action}</code> {t.purpose} → {t.path}
            {t.scope === "user" ? " (user-global)" : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
