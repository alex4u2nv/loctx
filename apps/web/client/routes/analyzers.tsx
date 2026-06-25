/**
 * Analyzers — the single place to provision, enable, tune, and reindex the
 * optional code analyzers. Consolidates what used to be split between the
 * Config page (enable toggles, rule_dirs, tuning, duplicate detection) and a
 * separate Admin install card, so configuring an analyzer never means
 * jumping between screens.
 *
 * Three groups:
 *   - Engine: master background switch + scheduling (concurrency, timeout).
 *   - Tools: lizard / semgrep / ast-grep — install & enable (downloads the
 *     binary, enables it, backfills), enable/disable, reindex, rule dirs,
 *     max findings.
 *   - Duplicate detection: a binary-free analyzer with its own params.
 */

import type { ToolStatus } from "@shared/contracts";
import { type ReactNode, useState } from "react";
import { AdminTabs } from "../components/admin-tabs";
import { Icon } from "../components/icon";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

/** Config dot-paths per rule-pack tool. */
const TOOL_KEYS: Record<string, { enabled: string; ruleDirs?: string; maxFindings?: string }> = {
  lizard: { enabled: "analyzers.lizard.enabled" },
  semgrep: {
    enabled: "analyzers.semgrep.enabled",
    ruleDirs: "analyzers.semgrep.ruleDirs",
    maxFindings: "analyzers.semgrep.maxFindingsPerFile",
  },
  "ast-grep": {
    enabled: "analyzers.astGrep.enabled",
    ruleDirs: "analyzers.astGrep.ruleDirs",
    maxFindings: "analyzers.astGrep.maxFindingsPerFile",
  },
};

export function AnalyzersPage() {
  const cfg = useFetch(() => api.config(), []);
  const tools = useFetch(() => api.toolsStatus(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [log, setLog] = useState<{ tool: string; ok: boolean; text: string } | null>(null);
  const [dirEdits, setDirEdits] = useState<Record<string, string>>({});
  const [listEdits, setListEdits] = useState<Record<string, string>>({});
  const [schemaUrl, setSchemaUrl] = useState("");

  const num = (key: string, dflt: number): number => {
    const v = cfg.data?.effective?.[key];
    return typeof v === "number" ? v : dflt;
  };
  const bool = (key: string): boolean => cfg.data?.effective?.[key] === true;
  const strList = (key: string): string[] => {
    const v = cfg.data?.effective?.[key];
    return Array.isArray(v) ? (v as string[]) : [];
  };
  // Save a comma/newline-separated list field as a string[] config value.
  const saveList = (key: string, note?: string): void => {
    const items = (listEdits[key] ?? "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    void save(key, items, note);
  };

  // Write one config field, then refresh. Used by every toggle / number.
  const save = async (key: string, value: unknown, note?: string): Promise<void> => {
    setBusy(key);
    setMsg(null);
    try {
      await api.configWrite({ patch: { [key]: value } });
      setMsg(note ?? "Saved.");
      cfg.reload();
      tools.reload();
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

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
      tools.reload();
      cfg.reload();
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

  // Append a stored schema path to analyzers.definitions.schemas + save.
  const addSchemaPath = (path: string): void => {
    const current = strList("analyzers.definitions.schemas");
    if (current.includes(path)) {
      setMsg("Schema already added.");
      return;
    }
    void save("analyzers.definitions.schemas", [...current, path], `Added schema: ${path}`);
  };

  const generateSchema = async (): Promise<void> => {
    setBusy("definitions");
    setMsg(null);
    try {
      const r = await api.definitionsGenerateSchema();
      if (r.ok) {
        setMsg(`Generated a schema from ${r.scanned ?? 0} definition file(s).`);
        addSchemaPath(r.path);
      } else {
        setMsg(`Generate: ${r.error}`);
      }
    } catch (e) {
      setMsg(`Generate: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const addSchemaFrom = async (body: { url?: string; content?: string; name?: string }): Promise<void> => {
    setBusy("definitions");
    setMsg(null);
    try {
      const r = await api.definitionsAddSchema(body);
      if (r.ok) addSchemaPath(r.path);
      else setMsg(`Schema: ${r.error}`);
    } catch (e) {
      setMsg(`Schema: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const saveDirs = async (name: string): Promise<void> => {
    const key = TOOL_KEYS[name]?.ruleDirs;
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
      cfg.reload();
      tools.reload();
    } catch (e) {
      setMsg(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const toolList = (tools.data?.tools ?? []) as ReadonlyArray<ToolStatus>;
  const engineOn = bool("analyzers.backgroundEnabled");

  return (
    <section>
      <span className="eyebrow">Code analysis</span>
      <h1 className="display">Analyzers</h1>
      <p className="subtitle">
        Provision, enable, tune, and reindex the optional analyzers that enrich your index — all in
        one place.
      </p>

      <AdminTabs />

      {msg !== null ? (
        <p className="pullquote" style={{ borderLeftColor: "var(--primary)" }}>
          {msg}
        </p>
      ) : null}

      <div className="card-stack">
        {/* Engine */}
        <div className="card">
          <p className="card-section-title">Engine</p>
          <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            Master switch and scheduling for the background analyzer queue. Tools below only run
            while this is on.
          </p>
          <SettingRow label="Background analysis" help="Master switch for the analyzer queue.">
            <Switch
              checked={engineOn}
              disabled={busy !== null}
              onChange={(v) =>
                void save("analyzers.backgroundEnabled", v, v ? "Analysis on." : "Analysis off.")
              }
            />
          </SettingRow>
          <SettingRow label="Concurrency" help="How many analyzer tasks run in parallel.">
            <NumField
              value={num("analyzers.concurrency", 2)}
              min={1}
              max={16}
              disabled={busy !== null}
              onSave={(v) => void save("analyzers.concurrency", v)}
            />
          </SettingRow>
          <SettingRow label="Per-task timeout (ms)" help="Per-task wall-clock timeout.">
            <NumField
              value={num("analyzers.perTaskTimeoutMs", 60000)}
              min={1000}
              max={600000}
              disabled={busy !== null}
              onSave={(v) => void save("analyzers.perTaskTimeoutMs", v)}
            />
          </SettingRow>
        </div>

        {/* Tools */}
        <div className="card">
          <p className="card-section-title">Tools</p>
          <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            <strong>Install &amp; enable</strong> downloads the tool into a loctx-managed location
            (no system changes), enables it, and backfills your index in one step. semgrep and
            ast-grep also need rule directories before they produce findings.
          </p>
          {toolList.map((t) => (
            <ToolBlock
              key={t.name}
              tool={t}
              busy={busy === t.name}
              dirValue={dirEdits[t.name] ?? (t.ruleDirs ?? []).join(", ")}
              maxFindings={
                TOOL_KEYS[t.name]?.maxFindings !== undefined
                  ? num(TOOL_KEYS[t.name]?.maxFindings as string, 50)
                  : null
              }
              onInstall={() => void install(t.name)}
              onReindex={() => void reindex(t.name)}
              onToggle={(v) => {
                const key = TOOL_KEYS[t.name]?.enabled;
                if (key) void save(key, v, `${t.name} ${v ? "enabled" : "disabled"}.`);
              }}
              onDirChange={(v) => setDirEdits((p) => ({ ...p, [t.name]: v }))}
              onSaveDirs={() => void saveDirs(t.name)}
              onMaxFindings={(v) => {
                const key = TOOL_KEYS[t.name]?.maxFindings;
                if (key) void save(key, v);
              }}
            />
          ))}
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

        {/* Duplicate detection */}
        <div className="card">
          <p className="card-section-title">Duplicate detection</p>
          <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            Token-window near-duplicate finder. No binary to install — just enable and tune.
          </p>
          <SettingRow label="Enabled" help="Run the duplicate detector during analysis.">
            <Switch
              checked={bool("analyzers.duplicates.enabled")}
              disabled={busy !== null}
              onChange={(v) =>
                void save(
                  "analyzers.duplicates.enabled",
                  v,
                  v ? "Duplicate detection on." : "Duplicate detection off.",
                )
              }
            />
          </SettingRow>
          <SettingRow label="Window size" help="Sliding-window size in tokens.">
            <NumField
              value={num("analyzers.duplicates.windowSize", 50)}
              min={5}
              max={1000}
              disabled={busy !== null}
              onSave={(v) => void save("analyzers.duplicates.windowSize", v)}
            />
          </SettingRow>
          <SettingRow label="Min unique tokens" help="Skip windows with fewer unique tokens.">
            <NumField
              value={num("analyzers.duplicates.minUniqueTokens", 15)}
              min={1}
              max={1000}
              disabled={busy !== null}
              onSave={(v) => void save("analyzers.duplicates.minUniqueTokens", v)}
            />
          </SettingRow>
        </div>

        {/* Definitions (agent / skill / knowledge schema validation) */}
        <div className="card">
          <p className="card-section-title">Definitions</p>
          <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            Validates agent / skill / knowledge markdown frontmatter against a schema. Ships with{" "}
            <strong>Open Knowledge Format (OKF) v0.1</strong> as the zero-config default; layer your
            own schemas by path or GitHub URL. No binary to install.
          </p>
          <SettingRow label="Enabled" help="Validate matching .md files during analysis.">
            <Switch
              checked={bool("analyzers.definitions.enabled")}
              disabled={busy !== null}
              onChange={(v) =>
                void save("analyzers.definitions.enabled", v, v ? "Definitions on." : "Definitions off.")
              }
            />
          </SettingRow>
          <SettingRow label="OKF v0.1 default" help="Apply the bundled Open Knowledge Format schema.">
            <Switch
              checked={bool("analyzers.definitions.okfDefault")}
              disabled={busy !== null}
              onChange={(v) => void save("analyzers.definitions.okfDefault", v)}
            />
          </SettingRow>
          <SettingRow
            label="Require frontmatter"
            help="Flag matched files that have no frontmatter block at all."
          >
            <Switch
              checked={bool("analyzers.definitions.requireFrontmatter")}
              disabled={busy !== null}
              onChange={(v) => void save("analyzers.definitions.requireFrontmatter", v)}
            />
          </SettingRow>
          <SettingRow
            label="Check cross-links"
            help="Flag relative markdown links that don't resolve to a file."
          >
            <Switch
              checked={bool("analyzers.definitions.checkLinks")}
              disabled={busy !== null}
              onChange={(v) => void save("analyzers.definitions.checkLinks", v)}
            />
          </SettingRow>
          <ListField
            label="File globs"
            help="Project-relative globs selecting which .md files are definitions."
            placeholder=".claude/skills/**/*.md, AGENTS.md, **/SKILL.md"
            value={listEdits["analyzers.definitions.globs"] ?? strList("analyzers.definitions.globs").join(", ")}
            disabled={busy !== null}
            onChange={(v) => setListEdits((p) => ({ ...p, "analyzers.definitions.globs": v }))}
            onSave={() => saveList("analyzers.definitions.globs", "Globs saved.")}
          />
          <ListField
            label="Custom schemas"
            help="Extra JSON Schemas, by local path or GitHub URL (layered on top of OKF). URLs are fetched server-side."
            placeholder="./schemas/agent.json, https://raw.githubusercontent.com/org/repo/main/skill.schema.json"
            value={
              listEdits["analyzers.definitions.schemas"] ?? strList("analyzers.definitions.schemas").join(", ")
            }
            disabled={busy !== null}
            onChange={(v) => setListEdits((p) => ({ ...p, "analyzers.definitions.schemas": v }))}
            onSave={() => saveList("analyzers.definitions.schemas", "Schemas saved.")}
          />
          {/* Add a schema from URL / upload / generate — each stores a managed
              file and appends its path to the list above. */}
          <div
            style={{
              display: "flex",
              gap: "var(--space-2)",
              flexWrap: "wrap",
              alignItems: "center",
              padding: "var(--space-2) 0",
            }}
          >
            <input
              className="input"
              placeholder="https://…/schema.json"
              value={schemaUrl}
              disabled={busy !== null}
              onChange={(e) => setSchemaUrl(e.target.value)}
              style={{ fontSize: "0.8125rem", flex: "1 1 16rem" }}
            />
            <button
              type="button"
              className="btn"
              disabled={busy !== null || schemaUrl.trim() === ""}
              onClick={() => {
                void addSchemaFrom({ url: schemaUrl.trim() });
                setSchemaUrl("");
              }}
            >
              add from URL
            </button>
            <label className="btn" style={{ cursor: "pointer" }}>
              upload schema
              <input
                type="file"
                accept=".json,.yaml,.yml"
                hidden
                disabled={busy !== null}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void file.text().then((content) => addSchemaFrom({ content, name: file.name }));
                  e.target.value = "";
                }}
              />
            </label>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void generateSchema()}
            >
              <Icon name="index" /> generate from my files
            </button>
          </div>
          <SettingRow label="Max findings/file" help="Cap findings persisted per file.">
            <NumField
              value={num("analyzers.definitions.maxFindingsPerFile", 50)}
              min={1}
              max={10000}
              disabled={busy !== null}
              onSave={(v) => void save("analyzers.definitions.maxFindingsPerFile", v)}
            />
          </SettingRow>
          <p style={{ marginTop: "var(--space-3)" }}>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void reindex("definitions")}
            >
              <Icon name="refresh" animate={busy === "definitions"} /> reindex definitions
            </button>
          </p>
        </div>
      </div>
    </section>
  );
}

// ---- per-tool block ----------------------------------------------------

function statusBadge(t: ToolStatus): { cls: string; warn: boolean; label: string } {
  if (!t.installed) return { cls: "", warn: false, label: "available" };
  if (t.needsRules) return { cls: "", warn: true, label: "installed · needs rules" };
  const usingRegistry = t.enabled && (t.ruleDirs?.length ?? 0) === 0 && t.registryConfig;
  if (usingRegistry) {
    const which = t.name === "ast-grep" ? "starter rules" : "community rules";
    return { cls: "ok", warn: false, label: `installed · enabled · ${which}` };
  }
  if (t.enabled) return { cls: "ok", warn: false, label: "installed · enabled" };
  return { cls: "", warn: false, label: "installed · disabled" };
}

/** Per-tool note under the rule-dirs row: registry default or BYO guidance. */
function RulesHint({ tool }: { tool: ToolStatus }) {
  const hasDirs = (tool.ruleDirs?.length ?? 0) > 0;
  if (!tool.installed || hasDirs) return null;
  if (tool.registryConfig) {
    return tool.name === "ast-grep" ? (
      <p className="setting-row-help" style={{ marginTop: "var(--space-1)" }}>
        ast-grep has no community registry, so loctx runs a small{" "}
        <strong>bundled starter ruleset</strong> (no setup needed) — e.g. leftover{" "}
        <code>debugger</code> / <code>breakpoint()</code> and focused <code>.only</code> tests. Point
        it at your own rule dirs above to replace them; see{" "}
        <a href="https://ast-grep.github.io/guide/rule-config.html" target="_blank" rel="noreferrer">
          ast-grep rule config
        </a>
        .
      </p>
    ) : (
      <p className="setting-row-help" style={{ marginTop: "var(--space-1)" }}>
        Running semgrep's community pack <code>{tool.registryConfig}</code> (no setup needed). Add
        rule dirs above to use your own instead.
      </p>
    );
  }
  if (tool.needsRules) {
    return (
      <p className="setting-row-help" style={{ marginTop: "var(--space-1)", color: "var(--warn)" }}>
        No rules configured — point this analyzer at your own rule directories above.
      </p>
    );
  }
  return null;
}

function ToolBlock({
  tool,
  busy,
  dirValue,
  maxFindings,
  onInstall,
  onReindex,
  onToggle,
  onDirChange,
  onSaveDirs,
  onMaxFindings,
}: {
  tool: ToolStatus;
  busy: boolean;
  dirValue: string;
  maxFindings: number | null;
  onInstall: () => void;
  onReindex: () => void;
  onToggle: (v: boolean) => void;
  onDirChange: (v: string) => void;
  onSaveDirs: () => void;
  onMaxFindings: (v: number) => void;
}) {
  const badge = statusBadge(tool);
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-inner)",
        background: "var(--surface-2)",
        padding: "var(--space-3)",
        marginTop: "var(--space-3)",
      }}
    >
      <div className="tool-row" style={{ borderTop: "none", padding: 0 }}>
        <span className="metric-value" style={{ minWidth: "6rem", display: "inline-block" }}>
          {tool.name}
        </span>
        <span
          className={`daemon-status ${badge.cls}`}
          {...(badge.warn ? { style: { color: "var(--warn)" } } : {})}
        >
          <span className="dot-mark" />
          {badge.label}
        </span>
        <span
          style={{ marginLeft: "auto", display: "inline-flex", gap: "var(--space-3)", alignItems: "center" }}
        >
          {tool.installed ? (
            <>
              <Switch checked={tool.enabled} disabled={busy} onChange={onToggle} />
              <button type="button" className="btn" disabled={busy} onClick={onReindex}>
                <Icon name="refresh" animate={busy} /> reindex
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={onInstall}>
              <Icon name="index" /> install &amp; enable
            </button>
          )}
        </span>
      </div>
      {tool.ruleDirs !== null ? (
        <>
          <div
            style={{
              display: "flex",
              gap: "var(--space-2)",
              alignItems: "center",
              flexWrap: "wrap",
              marginTop: "var(--space-3)",
            }}
          >
            <input
              className="input"
              placeholder={`${tool.name} rule dirs (comma-separated absolute paths)`}
              value={dirValue}
              onChange={(e) => onDirChange(e.target.value)}
              style={{ fontSize: "0.8125rem", flex: "1 1 18rem" }}
            />
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={onSaveDirs}
              style={{ whiteSpace: "nowrap" }}
            >
              save &amp; reindex
            </button>
            {maxFindings !== null ? (
              <label
                className="dim"
                style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", fontSize: "0.8rem" }}
              >
                max findings/file
                <NumField value={maxFindings} min={1} max={10000} disabled={busy} onSave={onMaxFindings} />
              </label>
            ) : null}
          </div>
        </>
      ) : null}
      {tool.ruleDirs !== null ? <RulesHint tool={tool} /> : null}
    </div>
  );
}

// ---- small controls ----------------------------------------------------

/** A comma/newline-separated list field (globs, schema sources) + save. */
function ListField({
  label,
  help,
  placeholder,
  value,
  disabled,
  onChange,
  onSave,
}: {
  label: string;
  help: string;
  placeholder: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="setting-row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
      <div>
        <div className="setting-row-label">{label}</div>
        <p className="setting-row-help">{help}</p>
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flex: "1 1 22rem" }}>
        <input
          className="input"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{ fontSize: "0.8125rem" }}
        />
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={onSave}
          style={{ whiteSpace: "nowrap" }}
        >
          save
        </button>
      </div>
    </div>
  );
}

function SettingRow({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-row-label">{label}</div>
        <p className="setting-row-help">{help}</p>
      </div>
      {children}
    </div>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
    </label>
  );
}

/** Number input that commits on blur / Enter (not every keystroke). */
function NumField({
  value,
  min,
  max,
  disabled,
  onSave,
}: {
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onSave: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // Keep local text in sync when the saved value changes underneath us.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(String(value));
  }
  const commit = (): void => {
    const n = Number.parseInt(text, 10);
    if (Number.isInteger(n) && n >= min && n <= max && n !== value) onSave(n);
    else setText(String(value));
  };
  return (
    <input
      className="input setting-num"
      type="number"
      min={min}
      max={max}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
