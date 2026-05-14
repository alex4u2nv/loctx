/**
 * Config editor.
 *
 * Renders a schema-driven form for the layered YAML config (global +
 * project) with per-leaf source pills, type-specific editors, and an
 * explicit "save target" picker so the user always sees which file
 * their changes land in.
 *
 * Design notes:
 *   - Fields default to the *effective* (post-merge) value. A change
 *     becomes a pending patch keyed by dot-path.
 *   - Save target defaults to the layer of the *first edited field*'s
 *     current source — i.e. if you edit a project-overridden value,
 *     the writer defaults to the project YAML.
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
import { Icon } from "../components/icon";
import { type NavSection, SectionNav } from "../components/section-nav";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";

type Patch = Record<string, unknown>;

export function ConfigPage() {
  const { data, error, loading, reload } = useFetch(() => api.config(), []);
  const [patch, setPatch] = useState<Patch>({});
  const [target, setTarget] = useState<"global" | "project">("global");
  const [saveState, setSaveState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; path: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [restartState, setRestartState] = useState<"idle" | "restarting" | "done">("idle");

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
      const r = await api.configWrite({ target, patch });
      setSaveState({ kind: "saved", path: r.path });
      setPatch({});
      reload();
    } catch (e) {
      setSaveState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const onRestart = async (): Promise<void> => {
    if (!window.confirm("Restart the daemon to apply config changes?")) return;
    setRestartState("restarting");
    try {
      await api.restart();
      setRestartState("done");
    } catch {
      setRestartState("idle");
    }
  };

  const navSections: NavSection[] = data.schema.map((s) => ({
    id: `cfg-${s.id}`,
    label: s.label,
  }));

  return (
    <section>
      <span className="eyebrow">Configuration</span>
      <h1 className="display">Config editor</h1>
      <p className="subtitle">
        Layered YAML config — global ⊳ project ⊳ env. Each field shows where its current value
        came from; pick a save target before applying changes.
      </p>

      <LayerSummary data={data} />

      <SaveBar
        pendingCount={pendingCount}
        target={target}
        onTargetChange={setTarget}
        data={data}
        onSave={() => void onSave()}
        saveState={saveState}
      />

      {saveState.kind === "saved" ? (
        <RestartBanner state={restartState} onClick={() => void onRestart()} path={saveState.path} />
      ) : null}

      {data.schema.map((section) => (
        <SectionEditor
          key={section.id}
          section={section}
          data={data}
          patch={patch}
          target={target}
          onChange={setField}
        />
      ))}

      <p className="dim" style={{ fontSize: "0.85rem", marginTop: "var(--space-5)" }}>
        Filtering rules (gitignore-style) live in <code>~/.loctx/config_overrides/*.yaml</code>{" "}
        and aren't edited here.
      </p>

      <SectionNav sections={navSections} />
    </section>
  );
}

// ---- layer summary -----------------------------------------------------

function LayerSummary({ data }: { data: ConfigPayload }) {
  return (
    <p className="summary">
      global: <code>{data.globalSource ?? "(default — file not yet created)"}</code>
      <span className="sep">·</span>
      project: <code>{data.projectSource ?? `(none — would create at ${data.suggestedProjectPath})`}</code>
    </p>
  );
}

// ---- top save bar ------------------------------------------------------

function SaveBar({
  pendingCount,
  target,
  onTargetChange,
  data,
  onSave,
  saveState,
}: {
  pendingCount: number;
  target: "global" | "project";
  onTargetChange: (t: "global" | "project") => void;
  data: ConfigPayload;
  onSave: () => void;
  saveState:
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; path: string }
    | { kind: "error"; message: string };
}) {
  const targetPath = target === "global"
    ? data.globalSource ?? "<global config> (will create)"
    : data.projectSource ?? `${data.suggestedProjectPath} (will create)`;

  return (
    <div className="config-savebar">
      <div className="config-savebar-info">
        <span className="config-pending-count">{pendingCount}</span>
        <span className="dim">pending change{pendingCount === 1 ? "" : "s"}</span>
      </div>
      <label className="config-target">
        <span className="dim">save to</span>
        <select
          className="input config-target-select"
          value={target}
          onChange={(e) => onTargetChange(e.target.value as "global" | "project")}
        >
          <option value="global">global YAML</option>
          <option value="project">project YAML (.loctx.yaml)</option>
        </select>
        <code className="config-target-path">{targetPath}</code>
      </label>
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
}: {
  state: "idle" | "restarting" | "done";
  onClick: () => void;
  path: string;
}) {
  if (state === "done") {
    return (
      <p className="pullquote" style={{ borderLeftColor: "var(--ok)", color: "var(--ok)" }}>
        Daemon restart issued — reconnect from the launcher to pick up the new config.
      </p>
    );
  }
  return (
    <p className="pullquote" style={{ borderLeftColor: "var(--ok)" }}>
      Saved to <code>{path}</code>. Most settings only take effect on next daemon load.{" "}
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
  target,
  onChange,
}: {
  section: ConfigSectionSchemaWire;
  data: ConfigPayload;
  patch: Patch;
  target: "global" | "project";
  onChange: (key: string, value: unknown) => void;
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
            target={target}
            onChange={onChange}
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
  target,
  onChange,
}: {
  field: ConfigFieldSchemaWire;
  data: ConfigPayload;
  patch: Patch;
  target: "global" | "project";
  onChange: (key: string, value: unknown) => void;
}) {
  const baseline = data.effective[field.key];
  const pending = field.key in patch;
  const value = pending ? patch[field.key] : baseline;
  const source: ConfigSourceKind = data.sources[field.key] ?? "default";

  const restricted = field.globalOnly === true && target === "project";
  const validation = useMemo(() => validate(field, value), [field, value]);

  const onReset = () => onChange(field.key, field.default);

  return (
    <div className={`config-field ${pending ? "pending" : ""}`}>
      <div className="config-field-head">
        <label className="config-field-label" htmlFor={`f-${field.key}`}>
          {field.label}
        </label>
        <SourcePill kind={source} />
        {field.globalOnly === true ? (
          <span className="config-pill config-pill-locked" title="Global-only field — projects cannot override.">
            global-only
          </span>
        ) : null}
      </div>
      <p className="config-field-help dim">{field.help}</p>
      <FieldEditor
        field={field}
        value={value}
        onChange={(v) => onChange(field.key, v)}
        disabled={restricted}
      />
      {restricted ? (
        <p className="warn" style={{ fontSize: "0.8rem" }}>
          This field is global-only — switch the save target to global to edit it.
        </p>
      ) : null}
      {validation !== null ? (
        <p className="err" style={{ fontSize: "0.8rem" }}>
          {validation}
        </p>
      ) : null}
      {pending ? (
        <p className="config-field-foot">
          <span className="dim">was: </span>
          <code className="config-was">{formatDisplay(baseline)}</code>
          <button type="button" className="btn-link" onClick={onReset}>
            reset
          </button>
        </p>
      ) : null}
    </div>
  );
}

function SourcePill({ kind }: { kind: ConfigSourceKind }) {
  const cls = `config-pill config-pill-${kind}`;
  return <span className={cls}>{kind}</span>;
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
          <span>{value === true ? "enabled" : "disabled"}</span>
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
