/**
 * Config editor.
 *
 * Renders a schema-driven form for the global YAML config with per-leaf
 * source pills (default vs. global vs. env) and type-specific editors.
 * All writes land in the single global config file — the older project-
 * level layer was removed to keep the surface area honest.
 *
 * Design notes:
 *   - Fields default to the *effective* (post-merge) value. A change
 *     becomes a pending patch keyed by dot-path.
 *   - After save, a banner offers to restart the daemon (most settings
 *     only take effect after a fresh `loadConfig`).
 *   - Filtering rules live in a separate overlay system and aren't
 *     editable here; that's noted at the bottom.
 */

import type {
  ConfigFieldSchemaWire,
  ConfigPayload,
  ConfigSectionSchemaWire,
  ConfigSourceKind,
} from "@shared/contracts";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AdminTabs } from "../components/admin-tabs";
import { confirm } from "../components/confirm";
import { Icon } from "../components/icon";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

type Patch = Record<string, unknown>;

/** Analyzer sections owned by the Analyzers tab; hidden from this editor. */
const PANEL_OWNED_SECTIONS = new Set([
  "analyzers",
  "analyzers.lizard",
  "analyzers.duplicates",
  "analyzers.semgrep",
  "analyzers.astGrep",
]);

/**
 * Normalized grouping for the remaining settings so related concerns sit
 * together instead of a flat schema dump. Sections not listed fall under
 * "Other" at the end (keeps new schema sections visible without a code
 * change here).
 */
const CONFIG_CATEGORIES: ReadonlyArray<{ readonly label: string; readonly ids: ReadonlyArray<string> }> = [
  {
    label: "Indexing & search",
    ids: ["workspace", "discovery", "embedding", "retrieval", "watcher", "reconciliation"],
  },
  { label: "Server & network", ids: ["daemon", "mcp", "network"] },
];

export function ConfigPage() {
  const { data, error, loading, reload } = useFetch(() => api.config(), []);
  const [patch, setPatch] = useState<Patch>({});
  const [saveState, setSaveState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; path: string; reloaded: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [restartState, setRestartState] = useState<"idle" | "restarting" | "done">("idle");
  // Field whose help shows in the right detail panel — follows the row the
  // pointer/keyboard is on. Null until first hover; the panel then defaults
  // to the first field so it's never empty.
  const [activeKey, setActiveKey] = useState<string | null>(null);

  if (loading && data === null) return <p className="pullquote">Loading…</p>;
  if (error !== null)
    return (
      <p className="pullquote" style={{ borderLeftColor: "var(--bad)", color: "var(--bad)" }}>
        {error}
      </p>
    );
  if (data === null) return <p className="pullquote">No data.</p>;

  const pendingCount = Object.keys(patch).length;
  const setField = (key: string, value: unknown) => {
    setPatch((prev) => {
      const next = { ...prev };
      // If the new value matches the effective baseline, drop the patch
      // entry — keeps the pending-count honest when the user reverts.
      if (deepEqual(value, data.effective[key])) delete next[key];
      else next[key] = value;
      return next;
    });
    setSaveState({ kind: "idle" });
  };

  const onSave = async (): Promise<void> => {
    setSaveState({ kind: "saving" });
    try {
      const r = await api.configWrite({ patch });
      setSaveState({ kind: "saved", path: r.path, reloaded: r.reloaded ?? false });
      setPatch({});
      reload();
    } catch (e) {
      setSaveState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onRestart = async (): Promise<void> => {
    const ok = await confirm({
      title: "Restart daemon?",
      message: "Required for most config changes to take effect.",
      confirmLabel: "Restart",
    });
    if (!ok) return;
    setRestartState("restarting");
    try {
      await api.restart();
      setRestartState("done");
    } catch {
      setRestartState("idle");
    }
  };

  // The per-tool analyzer sections (install / enable / rule_dirs) are now
  // owned by the unified Analyzers panel on Admin, so they're hidden from
  // this generic editor — a bare `enabled` toggle here was a no-op footgun
  // (it didn't download the binary or backfill). Tuning that isn't tool
  // provisioning (background/concurrency/timeouts, duplicates) stays here.
  const sections = data.schema.filter((s) => !PANEL_OWNED_SECTIONS.has(s.id));

  // Group the visible sections into normalized categories; anything not
  // explicitly placed lands in a trailing "Other" group.
  const placed = new Set(CONFIG_CATEGORIES.flatMap((c) => c.ids));
  const categorized: ReadonlyArray<{ label: string; sections: ConfigSectionSchemaWire[] }> = [
    ...CONFIG_CATEGORIES.map((c) => ({
      label: c.label,
      sections: c.ids
        .map((id) => sections.find((s) => s.id === id))
        .filter((s): s is ConfigSectionSchemaWire => s !== undefined),
    })),
    { label: "Other", sections: sections.filter((s) => !placed.has(s.id)) },
  ].filter((g) => g.sections.length > 0);

  // Flat field lookup so the help panel can resolve the active field +
  // its section regardless of which section it lives in.
  const fieldIndex = new Map<
    string,
    { field: ConfigFieldSchemaWire; section: ConfigSectionSchemaWire }
  >();
  for (const section of sections) {
    for (const f of section.fields) fieldIndex.set(f.key, { field: f, section });
  }
  const activeFieldKey = activeKey ?? sections[0]?.fields[0]?.key ?? null;
  const active = activeFieldKey !== null ? (fieldIndex.get(activeFieldKey) ?? null) : null;

  return (
    <section>
      <span className="eyebrow">Configuration</span>
      <h1 className="display">Config editor</h1>
      <p className="subtitle">
        Layered YAML config — global ⊳ project ⊳ env. Each field shows where its current value
        came from; pick a save target before applying changes.
      </p>

      <AdminTabs />

      <LayerSummary data={data} />

      <SaveBar
        pendingCount={pendingCount}
        data={data}
        onSave={() => void onSave()}
        saveState={saveState}
      />

      {saveState.kind === "saved" ? (
        <RestartBanner
          state={restartState}
          onClick={() => void onRestart()}
          path={saveState.path}
          reloaded={saveState.reloaded}
        />
      ) : null}

      <div className="config-layout">
        <div className="config-main">
          {categorized.map((group) => (
            <div key={group.label}>
              <p className="config-category">{group.label}</p>
              {group.sections.map((section) => (
                <SectionEditor
                  key={section.id}
                  section={section}
                  data={data}
                  patch={patch}
                  onChange={setField}
                  activeKey={activeFieldKey}
                  onActivate={setActiveKey}
                />
              ))}
            </div>
          ))}

          <p className="dim" style={{ fontSize: "0.85rem", marginTop: "var(--space-5)" }}>
            Analyzers (lizard, semgrep, ast-grep, duplicate detection) — install, enable, tune, rule
            dirs and reindex — are managed on the <Link to="/analyzers">Analyzers</Link> tab.
            Embedding models are switched on <Link to="/models">Models</Link>. Filtering rules
            (gitignore-style) live in <code>~/.loctx/config_overrides/*.yaml</code> and aren't
            edited here.
          </p>
        </div>

        <ConfigHelp active={active} data={data} patch={patch} />
      </div>
    </section>
  );
}

// ---- layer summary -----------------------------------------------------

function LayerSummary({ data }: { data: ConfigPayload }) {
  return (
    <p className="summary">
      global: <code>{data.globalSource ?? "(default — file not yet created)"}</code>
    </p>
  );
}

// ---- top save bar ------------------------------------------------------

function SaveBar({
  pendingCount,
  data,
  onSave,
  saveState,
}: {
  pendingCount: number;
  data: ConfigPayload;
  onSave: () => void;
  saveState:
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; path: string; reloaded: boolean }
    | { kind: "error"; message: string };
}) {
  const targetPath = data.globalSource ?? "<global config> (will create)";

  return (
    <div className="config-savebar">
      <div className="config-savebar-info">
        <span className="config-pending-count">{pendingCount}</span>
        <span className="dim">pending change{pendingCount === 1 ? "" : "s"}</span>
      </div>
      <span className="config-target">
        <span className="dim">save to</span>
        <code className="config-target-path">{targetPath}</code>
      </span>
      <button
        type="button"
        className="btn btn-primary"
        onClick={onSave}
        disabled={pendingCount === 0 || saveState.kind === "saving"}
      >
        {saveState.kind === "saving" ? (
          <>
            <Icon name="refresh" /> Saving…
          </>
        ) : (
          <>
            <Icon name="ok" /> Save
          </>
        )}
      </button>
      {saveState.kind === "error" ? (
        <span className="err config-save-error">{saveState.message}</span>
      ) : null}
    </div>
  );
}

function RestartBanner({
  state,
  onClick,
  path,
  reloaded,
}: {
  state: "idle" | "restarting" | "done";
  onClick: () => void;
  path: string;
  reloaded: boolean;
}) {
  if (state === "done") {
    return (
      <p className="pullquote" style={{ borderLeftColor: "var(--ok)", color: "var(--ok)" }}>
        Daemon restart issued — reconnect from the launcher to pick up the new config.
      </p>
    );
  }
  // Hot-reloaded: the change is already live. Only a few settings (daemon
  // port/hostname, embedding model) can't apply without a restart, so the
  // button stays available but the framing flips from "needed" to "only if
  // you changed one of those".
  return (
    <p className="pullquote" style={{ borderLeftColor: "var(--ok)" }}>
      Saved to <code>{path}</code>.{" "}
      {reloaded
        ? "Applied live — analyzer toggles and the reconciliation interval took effect. Retrieval mode, watcher debounce, daemon port/hostname, and the embedding model still need a restart."
        : "Most settings only take effect on next daemon load."}{" "}
      <button
        type="button"
        className="btn"
        onClick={onClick}
        disabled={state === "restarting"}
        style={{ marginLeft: "var(--space-2)" }}
      >
        {state === "restarting" ? "Restarting…" : "Restart daemon"}
      </button>
    </p>
  );
}

// ---- section + field editors ------------------------------------------

function SectionEditor({
  section,
  data,
  patch,
  onChange,
  activeKey,
  onActivate,
}: {
  section: ConfigSectionSchemaWire;
  data: ConfigPayload;
  patch: Patch;
  onChange: (key: string, value: unknown) => void;
  activeKey: string | null;
  onActivate: (key: string) => void;
}) {
  return (
    <article className="config-section card" id={`cfg-${section.id}`}>
      <header className="config-section-head">
        <h2 className="card-title">{section.label}</h2>
        <p className="dim">{section.help}</p>
      </header>
      <div className="config-fields">
        {section.fields.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            data={data}
            patch={patch}
            onChange={onChange}
            active={field.key === activeKey}
            onActivate={onActivate}
          />
        ))}
      </div>
    </article>
  );
}

function FieldRow({
  field,
  data,
  patch,
  onChange,
  active,
  onActivate,
}: {
  field: ConfigFieldSchemaWire;
  data: ConfigPayload;
  patch: Patch;
  onChange: (key: string, value: unknown) => void;
  active: boolean;
  onActivate: (key: string) => void;
}) {
  const baseline = data.effective[field.key];
  const pending = field.key in patch;
  const value = pending ? patch[field.key] : baseline;
  const source: ConfigSourceKind = data.sources[field.key] ?? "default";

  const validation = useMemo(() => validate(field, value), [field, value]);

  const onReset = () => onChange(field.key, field.default);

  return (
    <div
      className={`config-field ${pending ? "pending" : ""} ${active ? "active" : ""}`}
      onMouseEnter={() => onActivate(field.key)}
      onFocusCapture={() => onActivate(field.key)}
    >
      <div className="config-field-head">
        <label className="config-field-label" htmlFor={`f-${field.key}`}>
          {field.label}
        </label>
        <SourcePill kind={source} field={field} />
      </div>
      <div className="config-field-control">
        <FieldEditor
          field={field}
          value={value}
          onChange={(v) => onChange(field.key, v)}
          disabled={false}
        />
        {validation !== null ? <p className="config-field-error err">{validation}</p> : null}
        {pending ? (
          <span className="config-field-foot">
            <span className="dim">was</span>
            <code className="config-was">{formatDisplay(baseline)}</code>
            <button type="button" className="btn-link" onClick={onReset}>
              reset
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SourcePill({ kind, field }: { kind: ConfigSourceKind; field: ConfigFieldSchemaWire }) {
  const cls = `config-pill config-pill-${kind}`;
  // Spell out the default value for default-sourced fields so the user
  // doesn't have to guess whether the built-in default is true or false
  // (or some specific number) just from the checkbox / input state.
  const text = kind === "default" ? `default: ${formatDefault(field)}` : kind;
  return <span className={cls}>{text}</span>;
}

function formatDefault(field: ConfigFieldSchemaWire): string {
  if (field.type === "bool") return field.default === true ? "on" : "off";
  return formatDisplay(field.default);
}

/** Sticky right-hand detail panel: full help + metadata for the active
 *  field. Stays open and re-renders as the pointer/keyboard moves between
 *  rows, so help is always one glance away without crowding the rows. */
function ConfigHelp({
  active,
  data,
  patch,
}: {
  active: { field: ConfigFieldSchemaWire; section: ConfigSectionSchemaWire } | null;
  data: ConfigPayload;
  patch: Patch;
}) {
  if (active === null) {
    return (
      <aside className="config-help">
        <p className="dim">Hover or focus a setting to see its details.</p>
      </aside>
    );
  }
  const { field, section } = active;
  const source: ConfigSourceKind = data.sources[field.key] ?? "default";
  const value = field.key in patch ? patch[field.key] : data.effective[field.key];
  return (
    <aside className="config-help">
      <p className="config-help-eyebrow">{section.label}</p>
      <h3 className="config-help-title">{field.label}</h3>
      {field.help ? <p className="config-help-text">{field.help}</p> : null}
      <dl className="config-help-meta">
        <dt>key</dt>
        <dd>
          <code>{field.key}</code>
        </dd>
        <dt>type</dt>
        <dd>{field.type}</dd>
        <dt>default</dt>
        <dd>
          <code>{formatDefault(field)}</code>
        </dd>
        <dt>current</dt>
        <dd>
          <code>{formatDisplay(value)}</code>
        </dd>
        <dt>source</dt>
        <dd>
          <SourcePill kind={source} field={field} />
        </dd>
      </dl>
    </aside>
  );
}

function FieldEditor({
  field,
  value,
  onChange,
  disabled,
}: {
  field: ConfigFieldSchemaWire;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  const id = `f-${field.key}`;
  switch (field.type) {
    case "bool":
      return (
        <label className="config-toggle">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
          />
          <span>{value === true ? "on" : "off"}</span>
        </label>
      );
    case "enum":
      return (
        <select
          id={id}
          className="input"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        >
          {field.enumValues?.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
    case "int":
      return (
        <input
          id={id}
          className="input"
          type="number"
          step={1}
          {...(field.min !== undefined ? { min: field.min } : {})}
          {...(field.max !== undefined ? { max: field.max } : {})}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(Math.trunc(n));
          }}
          disabled={disabled}
        />
      );
    case "string":
      return (
        <input
          id={id}
          className="input"
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      );
    case "string-array":
      return (
        <StringArrayEditor
          id={id}
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          disabled={disabled}
        />
      );
  }
}

function StringArrayEditor({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: ReadonlyArray<string>;
  onChange: (v: string[]) => void;
  disabled: boolean;
}) {
  const text = value.join("\n");
  return (
    <textarea
      id={id}
      className="input config-array-textarea"
      rows={Math.max(2, value.length + 1)}
      value={text}
      placeholder="one entry per line"
      onChange={(e) => {
        const next = e.target.value
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        onChange(next);
      }}
      disabled={disabled}
    />
  );
}

// ---- helpers -----------------------------------------------------------

function validate(field: ConfigFieldSchemaWire, value: unknown): string | null {
  switch (field.type) {
    case "string":
      return typeof value === "string" ? null : "must be a string";
    case "enum":
      if (typeof value !== "string") return "must be a string";
      if (field.enumValues && !field.enumValues.includes(value))
        return `must be one of ${field.enumValues.join(", ")}`;
      return null;
    case "bool":
      return typeof value === "boolean" ? null : "must be a boolean";
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) return "must be an integer";
      if (field.min !== undefined && value < field.min) return `must be ≥ ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be ≤ ${field.max}`;
      return null;
    case "string-array":
      return Array.isArray(value) && value.every((v) => typeof v === "string")
        ? null
        : "must be an array of strings";
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  return false;
}

function formatDisplay(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[${v.join(", ")}]`;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
