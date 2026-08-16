/**
 * Analyzers — the single place to provision, enable, tune, and reindex the
 * optional code analyzers. Consolidates what used to be split between the
 * Config page (enable toggles, rule_dirs, tuning, duplicate detection) and a
 * separate Admin install card, so configuring an analyzer never means
 * jumping between screens.
 *
 * Four cards (2026-08-06 audit, WEB-3):
 *   - EngineCard: master background switch + scheduling (concurrency, timeout).
 *   - ToolsCard: lizard / semgrep / ast-grep — install & enable (downloads the
 *     binary, enables it, backfills), enable/disable, reindex, rule dirs,
 *     max findings.
 *   - DuplicatesCard: a binary-free analyzer with its own params.
 *   - DefinitionsCard: agent / skill / knowledge schema validation.
 *
 * A save disables only its own card's controls (per-card busy) instead of
 * greying out the whole page; the message banner stays page-level. Config
 * access goes through the typed `CFG` / `TOOL_KEYS` constants (WEB-10) and
 * the busy/message runner is the shared `useOpRunner` (WEB-6).
 */

import type { AnalyzerToolName, ToolStatus } from "@shared/contracts";
import { useCallback, useState } from "react";
import { AdminTabs } from "../components/admin-tabs";
import { Banner } from "../components/banner";
import { IconButton } from "../components/icon-button";
import { api } from "../lib/api";
import { useFetch } from "../lib/use-fetch";
import { type OpRunner, useOpRunner } from "../lib/use-op-runner";

// ---- typed config keys (WEB-10) ----------------------------------------

/** Non-tool config dot-paths, hoisted out of the JSX. */
const CFG = {
  engineEnabled: "analyzers.backgroundEnabled",
  concurrency: "analyzers.concurrency",
  perTaskTimeoutMs: "analyzers.perTaskTimeoutMs",
  dupEnabled: "analyzers.duplicates.enabled",
  dupWindowSize: "analyzers.duplicates.windowSize",
  dupMinUniqueTokens: "analyzers.duplicates.minUniqueTokens",
  dupSemantic: "analyzers.duplicates.semantic",
  dupSemanticThreshold: "analyzers.duplicates.semanticThreshold",
  dupSemanticMaxChunks: "analyzers.duplicates.semanticMaxChunks",
  qualityEnabled: "analyzers.quality.enabled",
  qualityMarkdownRules: "analyzers.quality.markdownRules",
  qualityMaxFindings: "analyzers.quality.maxFindingsPerFile",
  qualityDocDriftFloor: "analyzers.quality.docDriftFloor",
  defEnabled: "analyzers.definitions.enabled",
  defOkfDefault: "analyzers.definitions.okfDefault",
  defRequireFrontmatter: "analyzers.definitions.requireFrontmatter",
  defCheckLinks: "analyzers.definitions.checkLinks",
  defGlobs: "analyzers.definitions.globs",
  defSchemas: "analyzers.definitions.schemas",
  defMaxFindings: "analyzers.definitions.maxFindingsPerFile",
} as const;

/**
 * Config dot-paths per tool, keyed off the shared contracts' tool union
 * so a new tool can't ship without its key set. Uniform shape (null for
 * N/A) keeps indexed access typed.
 */
const TOOL_KEYS = {
  lizard: { enabled: "analyzers.lizard.enabled", ruleDirs: null, maxFindings: null },
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
} as const satisfies Record<
  AnalyzerToolName,
  { enabled: string; ruleDirs: string | null; maxFindings: string | null }
>;

type ToolKeySet = (typeof TOOL_KEYS)[AnalyzerToolName];
type ConfigKey =
  | (typeof CFG)[keyof typeof CFG]
  | Exclude<ToolKeySet["enabled" | "ruleDirs" | "maxFindings"], null>;

// ---- typed config reads (WEB-10) ---------------------------------------

interface ConfigReader {
  num(key: ConfigKey, dflt: number): number;
  bool(key: ConfigKey): boolean;
  strList(key: ConfigKey): ReadonlyArray<string>;
}

function makeReader(effective: Readonly<Record<string, unknown>> | undefined): ConfigReader {
  return {
    num: (key, dflt) => {
      const v = effective?.[key];
      return typeof v === "number" ? v : dflt;
    },
    bool: (key) => effective?.[key] === true,
    strList: (key) => {
      const v = effective?.[key];
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    },
  };
}

/** Parse a comma/newline-separated field into a clean string[]. */
function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- config writer (WEB-3 / WEB-6) -------------------------------------

interface ConfigWriter {
  /** Key / tool name of the op in flight — cards match it to their own keys. */
  readonly busy: string | null;
  readonly message: string | null;
  readonly run: OpRunner["run"];
  readonly notify: OpRunner["notify"];
  save(key: ConfigKey, value: unknown, note?: string): Promise<void>;
}

function useConfigWriter(reload: () => void): ConfigWriter {
  const ops = useOpRunner(reload);
  const save = useCallback(
    async (key: ConfigKey, value: unknown, note?: string): Promise<void> => {
      await ops.run(key, () => api.configWrite({ patch: { [key]: value } }), {
        success: () => note ?? "Saved.",
      });
    },
    [ops.run],
  );
  return { busy: ops.busy, message: ops.message, run: ops.run, notify: ops.notify, save };
}

/** True when `busy` is one of this card's keys (per-card disable). */
function busyIn(busy: string | null, keys: ReadonlyArray<string | null>): boolean {
  return busy !== null && keys.includes(busy);
}

export function AnalyzersPage() {
  const cfg = useFetch(() => api.config(), []);
  const tools = useFetch(() => api.toolsStatus(), []);
  const reloadAll = useCallback(() => {
    cfg.reload();
    tools.reload();
  }, [cfg.reload, tools.reload]);
  const writer = useConfigWriter(reloadAll);
  const reader = makeReader(cfg.data?.effective);

  // Re-run an installed analyzer over the existing index. Shared by the
  // tool blocks and the definitions card ("definitions" is a virtual
  // tool name on the backfill endpoint).
  const reindex = useCallback(
    (name: string): Promise<unknown> =>
      writer.run(name, () => api.toolsBackfill(name), {
        success: (r) =>
          r.ok ? `${name} · reindex enqueued ${r.backfilled}` : `${name}: ${r.error}`,
      }),
    [writer.run],
  );

  return (
    <section>
      <span className="eyebrow">Code analysis</span>
      <h1 className="display">Analyzers</h1>
      <p className="subtitle">
        Provision, enable, tune, and reindex the optional analyzers that enrich your index — all in
        one place.
      </p>

      <AdminTabs />

      {writer.message !== null ? <Banner tone="info">{writer.message}</Banner> : null}

      <div className="card-stack">
        <EngineCard reader={reader} writer={writer} />
        <ToolsCard
          tools={tools.data?.tools ?? []}
          reader={reader}
          writer={writer}
          onReindex={reindex}
        />
        <DuplicatesCard reader={reader} writer={writer} />
        <QualityCard reader={reader} writer={writer} onReindex={reindex} />
        <DefinitionsCard reader={reader} writer={writer} onReindex={reindex} />
      </div>
    </section>
  );
}

// ---- cards -------------------------------------------------------------

interface CardProps {
  readonly reader: ConfigReader;
  readonly writer: ConfigWriter;
}

const ENGINE_KEYS: ReadonlyArray<string> = [
  CFG.engineEnabled,
  CFG.concurrency,
  CFG.perTaskTimeoutMs,
];

function EngineCard({ reader, writer }: CardProps) {
  const disabled = busyIn(writer.busy, ENGINE_KEYS);
  return (
    <div className="card">
      <p className="card-section-title">Engine</p>
      <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        Master switch and scheduling for the background analyzer queue. Tools below only run while
        this is on.
      </p>
      <SettingRow label="Background analysis" help="Master switch for the analyzer queue.">
        <Switch
          checked={reader.bool(CFG.engineEnabled)}
          disabled={disabled}
          onChange={(v) =>
            void writer.save(CFG.engineEnabled, v, v ? "Analysis on." : "Analysis off.")
          }
        />
      </SettingRow>
      <SettingRow label="Concurrency" help="How many analyzer tasks run in parallel.">
        <NumField
          value={reader.num(CFG.concurrency, 2)}
          min={1}
          max={16}
          disabled={disabled}
          onSave={(v) => void writer.save(CFG.concurrency, v)}
        />
      </SettingRow>
      <SettingRow label="Per-task timeout (ms)" help="Per-task wall-clock timeout.">
        <NumField
          value={reader.num(CFG.perTaskTimeoutMs, 60000)}
          min={1000}
          max={600000}
          disabled={disabled}
          onSave={(v) => void writer.save(CFG.perTaskTimeoutMs, v)}
        />
      </SettingRow>
    </div>
  );
}

function ToolsCard({
  tools,
  reader,
  writer,
  onReindex,
}: CardProps & {
  readonly tools: ReadonlyArray<ToolStatus>;
  readonly onReindex: (name: string) => Promise<unknown>;
}) {
  const [dirEdits, setDirEdits] = useState<Partial<Record<AnalyzerToolName, string>>>({});
  const [log, setLog] = useState<{ tool: string; ok: boolean; text: string } | null>(null);

  const install = (name: AnalyzerToolName): Promise<unknown> =>
    writer.run(
      name,
      async () => {
        setLog(null);
        const r = await api.toolsInstall(name);
        setLog({
          tool: name,
          ok: r.ok,
          text: r.ok ? (r.log ?? "(no output)") : r.log ? `${r.error}\n\n${r.log}` : r.error,
        });
        return r;
      },
      {
        success: (r) =>
          r.ok ? `${name} installed & enabled · backfill enqueued ${r.backfilled}` : null,
      },
    );

  const saveDirs = (tool: ToolStatus, dirValue: string): void => {
    const key = TOOL_KEYS[tool.name].ruleDirs;
    if (key === null) return;
    const dirs = parseList(dirValue);
    void writer.run(
      tool.name,
      async () => {
        await api.configWrite({ patch: { [key]: dirs } });
        return api.toolsBackfill(tool.name);
      },
      {
        success: (r) =>
          `${tool.name} · saved ${dirs.length} rule dir(s)${
            r.ok ? `, reindex enqueued ${r.backfilled}` : ""
          }`,
      },
    );
  };

  return (
    <div className="card">
      <p className="card-section-title">Tools</p>
      <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        <strong>Install &amp; enable</strong> downloads the tool into a loctx-managed location (no
        system changes), enables it, and backfills your index in one step. semgrep and ast-grep also
        need rule directories before they produce findings.
      </p>
      {tools.map((t) => {
        const keys = TOOL_KEYS[t.name];
        const busy = busyIn(writer.busy, [t.name, keys.enabled, keys.ruleDirs, keys.maxFindings]);
        const dirValue = dirEdits[t.name] ?? (t.ruleDirs ?? []).join(", ");
        return (
          <ToolBlock
            key={t.name}
            tool={t}
            busy={busy}
            dirValue={dirValue}
            maxFindings={keys.maxFindings !== null ? reader.num(keys.maxFindings, 50) : null}
            onInstall={() => void install(t.name)}
            onReindex={() => void onReindex(t.name)}
            onToggle={(v) =>
              void writer.save(keys.enabled, v, `${t.name} ${v ? "enabled" : "disabled"}.`)
            }
            onDirChange={(v) => setDirEdits((p) => ({ ...p, [t.name]: v }))}
            onSaveDirs={() => saveDirs(t, dirValue)}
            onMaxFindings={(v) => {
              if (keys.maxFindings !== null) void writer.save(keys.maxFindings, v);
            }}
          />
        );
      })}
      {log !== null ? (
        <details open style={{ marginTop: "var(--space-3)" }}>
          <summary>
            <span className={`daemon-status ${log.ok ? "ok" : "bad"}`}>
              <span className="dot-mark" />
              {log.tool} install {log.ok ? "log" : "failed"}
            </span>{" "}
            <IconButton
              className="btn-small ml-[var(--space-2)]"
              label="dismiss"
              onClick={() => setLog(null)}
            />
          </summary>
          <pre className="log-output">{log.text}</pre>
        </details>
      ) : null}
    </div>
  );
}

const QUALITY_KEYS: ReadonlyArray<string> = [
  CFG.qualityEnabled,
  CFG.qualityMarkdownRules,
  CFG.qualityMaxFindings,
  CFG.qualityDocDriftFloor,
];

/**
 * Heuristic quality rules (#522/#527) + the quality report they feed
 * (#525). Pure JS — nothing to install; thresholds beyond these live
 * in YAML (analyzers.quality.*).
 */
function QualityCard({
  reader,
  writer,
  onReindex,
}: CardProps & { readonly onReindex: (name: string) => Promise<unknown> }) {
  const disabled = busyIn(writer.busy, QUALITY_KEYS);
  return (
    <div className="card">
      <p className="card-section-title">Quality heuristics</p>
      <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        god-file, long-params, deep-nesting, fan-out, stale markdown refs — plus the cross-file
        report rules (fan-in, extract-candidate, cohesion, doc-drift). No binary to install.
      </p>
      <SettingRow label="Enabled" help="Run the quality analyzer during analysis.">
        <Switch
          checked={reader.bool(CFG.qualityEnabled)}
          disabled={disabled}
          onChange={(v) =>
            void writer.save(CFG.qualityEnabled, v, v ? "Quality rules on." : "Quality rules off.")
          }
        />
      </SettingRow>
      <SettingRow label="Markdown rules" help="Flag stale path references in indexed markdown.">
        <Switch
          checked={reader.bool(CFG.qualityMarkdownRules)}
          disabled={disabled}
          onChange={(v) => void writer.save(CFG.qualityMarkdownRules, v)}
        />
      </SettingRow>
      <SettingRow
        label="Doc-drift floor"
        help="Report flags docs below this doc/code similarity percent."
      >
        <NumField
          value={reader.num(CFG.qualityDocDriftFloor, 35)}
          min={5}
          max={95}
          disabled={disabled}
          onSave={(v) => void writer.save(CFG.qualityDocDriftFloor, v)}
        />
      </SettingRow>
      <SettingRow label="Max findings / file" help="Cap persisted findings per file.">
        <NumField
          value={reader.num(CFG.qualityMaxFindings, 50)}
          min={1}
          max={10_000}
          disabled={disabled}
          onSave={(v) => void writer.save(CFG.qualityMaxFindings, v)}
        />
      </SettingRow>
      <SettingRow label="Reindex" help="Re-run quality over already-indexed files.">
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => void onReindex("quality")}
        >
          Reindex
        </button>
      </SettingRow>
    </div>
  );
}

const DUPLICATES_KEYS: ReadonlyArray<string> = [
  CFG.dupEnabled,
  CFG.dupWindowSize,
  CFG.dupMinUniqueTokens,
  CFG.dupSemantic,
  CFG.dupSemanticThreshold,
  CFG.dupSemanticMaxChunks,
];

function DuplicatesCard({ reader, writer }: CardProps) {
  const disabled = busyIn(writer.busy, DUPLICATES_KEYS);
  return (
    <div className="card">
      <p className="card-section-title">Duplicate detection</p>
      <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        Token-window near-duplicate finder. No binary to install — just enable and tune.
      </p>
      <SettingRow label="Enabled" help="Run the duplicate detector during analysis.">
        <Switch
          checked={reader.bool(CFG.dupEnabled)}
          disabled={disabled}
          onChange={(v) =>
            void writer.save(
              CFG.dupEnabled,
              v,
              v ? "Duplicate detection on." : "Duplicate detection off.",
            )
          }
        />
      </SettingRow>
      <SettingRow label="Window size" help="Sliding-window size in tokens.">
        <NumField
          value={reader.num(CFG.dupWindowSize, 50)}
          min={5}
          max={1000}
          disabled={disabled}
          onSave={(v) => void writer.save(CFG.dupWindowSize, v)}
        />
      </SettingRow>
      <SettingRow label="Min unique tokens" help="Skip windows with fewer unique tokens.">
        <NumField
          value={reader.num(CFG.dupMinUniqueTokens, 15)}
          min={1}
          max={1000}
          disabled={disabled}
          onSave={(v) => void writer.save(CFG.dupMinUniqueTokens, v)}
        />
      </SettingRow>
      <SettingRow
        label="Semantic groups"
        help="Also report embedding-based near-duplicates ('same meaning, different text') in find_duplicates. Query-time; reads stored vectors."
      >
        <Switch
          checked={reader.bool(CFG.dupSemantic)}
          disabled={disabled}
          onChange={(v) =>
            void writer.save(
              CFG.dupSemantic,
              v,
              v ? "Semantic near-duplicates on." : "Semantic near-duplicates off.",
            )
          }
        />
      </SettingRow>
      <SettingRow
        label="Semantic threshold"
        help="Cosine-similarity floor as a percent (92 = 0.92)."
      >
        <NumField
          value={reader.num(CFG.dupSemanticThreshold, 92)}
          min={50}
          max={100}
          disabled={disabled}
          onSave={(v) => void writer.save(CFG.dupSemanticThreshold, v)}
        />
      </SettingRow>
      <SettingRow
        label="Semantic scan cap"
        help="Max chunks fed to the semantic pass per call. O(n²) in this cap — responses flag truncation when hit."
      >
        <NumField
          value={reader.num(CFG.dupSemanticMaxChunks, 3000)}
          min={100}
          max={5000}
          disabled={disabled}
          onSave={(v) => void writer.save(CFG.dupSemanticMaxChunks, v)}
        />
      </SettingRow>
    </div>
  );
}

/** Busy label used by the definitions schema/reindex flows. */
const DEFINITIONS_OP = "definitions";
const DEFINITIONS_KEY_PREFIX = "analyzers.definitions.";

function DefinitionsCard({
  reader,
  writer,
  onReindex,
}: CardProps & { readonly onReindex: (name: string) => Promise<unknown> }) {
  const [listEdits, setListEdits] = useState<Record<string, string>>({});
  const [schemaUrl, setSchemaUrl] = useState("");
  const disabled =
    writer.busy !== null &&
    (writer.busy === DEFINITIONS_OP || writer.busy.startsWith(DEFINITIONS_KEY_PREFIX));

  // Save a comma/newline-separated list field as a string[] config value.
  const saveList = (key: ConfigKey, raw: string, note?: string): void => {
    void writer.save(key, parseList(raw), note);
  };

  // Append a stored schema path to analyzers.definitions.schemas + save.
  const addSchemaPath = (path: string): void => {
    const current = reader.strList(CFG.defSchemas);
    if (current.includes(path)) {
      writer.notify("Schema already added.");
      return;
    }
    void writer.save(CFG.defSchemas, [...current, path], `Added schema: ${path}`);
  };

  const generateSchema = async (): Promise<void> => {
    const r = await writer.run(DEFINITIONS_OP, () => api.definitionsGenerateSchema(), {
      success: (res) =>
        res.ok
          ? `Generated a schema from ${res.scanned ?? 0} definition file(s).`
          : `Generate: ${res.error}`,
    });
    if (r?.ok) addSchemaPath(r.path);
  };

  const addSchemaFrom = async (body: {
    url?: string;
    content?: string;
    name?: string;
  }): Promise<void> => {
    const r = await writer.run(DEFINITIONS_OP, () => api.definitionsAddSchema(body), {
      success: (res) => (res.ok ? null : `Schema: ${res.error}`),
    });
    if (r?.ok) addSchemaPath(r.path);
  };

  const globsValue = listEdits[CFG.defGlobs] ?? reader.strList(CFG.defGlobs).join(", ");
  const schemasValue = listEdits[CFG.defSchemas] ?? reader.strList(CFG.defSchemas).join(", ");

  return (
    <div className="card">
      <p className="card-section-title">Definitions</p>
      <p className="dim" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        Validates agent / skill / knowledge markdown frontmatter against a schema. Ships with{" "}
        <strong>Open Knowledge Format (OKF) v0.1</strong> as the zero-config default; layer your own
        schemas by path or GitHub URL. No binary to install.
      </p>
      <SettingRow label="Enabled" help="Validate matching .md files during analysis.">
        <Switch
          checked={reader.bool(CFG.defEnabled)}
          disabled={disabled}
          onChange={(v) =>
            void writer.save(CFG.defEnabled, v, v ? "Definitions on." : "Definitions off.")
          }
        />
      </SettingRow>
      <SettingRow label="OKF v0.1 default" help="Apply the bundled Open Knowledge Format schema.">
        <Switch
          checked={reader.bool(CFG.defOkfDefault)}
          disabled={disabled}
          onChange={(v) => void writer.save(CFG.defOkfDefault, v)}
        />
      </SettingRow>
      <SettingRow
        label="Require frontmatter"
        help="Flag matched files that have no frontmatter block at all."
      >
        <Switch
          checked={reader.bool(CFG.defRequireFrontmatter)}
          disabled={disabled}
          onChange={(v) => void writer.save(CFG.defRequireFrontmatter, v)}
        />
      </SettingRow>
      <SettingRow
        label="Check cross-links"
        help="Flag relative markdown links that don't resolve to a file."
      >
        <Switch
          checked={reader.bool(CFG.defCheckLinks)}
          disabled={disabled}
          onChange={(v) => void writer.save(CFG.defCheckLinks, v)}
        />
      </SettingRow>
      <ListField
        label="File globs"
        help="Project-relative globs selecting which .md files are definitions."
        placeholder=".claude/skills/**/*.md, AGENTS.md, **/SKILL.md"
        value={globsValue}
        disabled={disabled}
        onChange={(v) => setListEdits((p) => ({ ...p, [CFG.defGlobs]: v }))}
        onSave={(v) => saveList(CFG.defGlobs, v, "Globs saved.")}
      />
      <ListField
        label="Custom schemas"
        help="Extra JSON Schemas, by local path or GitHub URL (layered on top of OKF). URLs are fetched server-side."
        placeholder="./schemas/agent.json, https://raw.githubusercontent.com/org/repo/main/skill.schema.json"
        value={schemasValue}
        disabled={disabled}
        onChange={(v) => setListEdits((p) => ({ ...p, [CFG.defSchemas]: v }))}
        onSave={(v) => saveList(CFG.defSchemas, v, "Schemas saved.")}
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
          disabled={disabled}
          onChange={(e) => setSchemaUrl(e.target.value)}
          style={{ fontSize: "0.8125rem", flex: "1 1 16rem" }}
        />
        <IconButton
          label="add from URL"
          disabled={disabled || schemaUrl.trim() === ""}
          onClick={() => {
            void addSchemaFrom({ url: schemaUrl.trim() });
            setSchemaUrl("");
          }}
        />
        <label className="btn" style={{ cursor: "pointer" }}>
          upload schema
          <input
            type="file"
            accept=".json,.yaml,.yml"
            hidden
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void file.text().then((content) => addSchemaFrom({ content, name: file.name }));
              e.target.value = "";
            }}
          />
        </label>
        <IconButton
          icon="index"
          label="generate from my files"
          disabled={disabled}
          onClick={() => void generateSchema()}
        />
      </div>
      <SettingRow label="Max findings/file" help="Cap findings persisted per file.">
        <NumField
          value={reader.num(CFG.defMaxFindings, 50)}
          min={1}
          max={10000}
          disabled={disabled}
          onSave={(v) => void writer.save(CFG.defMaxFindings, v)}
        />
      </SettingRow>
      <p style={{ marginTop: "var(--space-3)" }}>
        <IconButton
          icon="refresh"
          animate={writer.busy === DEFINITIONS_OP}
          label="reindex definitions"
          disabled={disabled}
          onClick={() => void onReindex(DEFINITIONS_OP)}
        />
      </p>
    </div>
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
        <code>debugger</code> / <code>breakpoint()</code> and focused <code>.only</code> tests.
        Point it at your own rule dirs above to replace them; see{" "}
        <a
          href="https://ast-grep.github.io/guide/rule-config.html"
          target="_blank"
          rel="noreferrer"
        >
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
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            gap: "var(--space-3)",
            alignItems: "center",
          }}
        >
          {tool.installed ? (
            <>
              <Switch checked={tool.enabled} disabled={busy} onChange={onToggle} />
              <IconButton
                icon="refresh"
                animate={busy}
                label="reindex"
                disabled={busy}
                onClick={onReindex}
              />
            </>
          ) : (
            <IconButton
              icon="index"
              className="btn-primary"
              label={<>install &amp; enable</>}
              disabled={busy}
              onClick={onInstall}
            />
          )}
        </span>
      </div>
      {tool.ruleDirs !== null ? (
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
          <IconButton
            className="whitespace-nowrap"
            label={<>save &amp; reindex</>}
            disabled={busy}
            onClick={onSaveDirs}
          />
          {maxFindings !== null ? (
            // biome-ignore lint/a11y/noLabelWithoutControl: the wrapped <NumField> renders the <input>; the rule can't see through the component boundary
            <label
              className="dim"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-2)",
                fontSize: "0.8rem",
              }}
            >
              max findings/file
              <NumField
                value={maxFindings}
                min={1}
                max={10000}
                disabled={busy}
                onSave={onMaxFindings}
              />
            </label>
          ) : null}
        </div>
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
  /** Receives the current field value so an untouched field saves what it shows. */
  onSave: (value: string) => void;
}) {
  return (
    <div className="setting-row" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
      <div>
        <div className="setting-row-label">{label}</div>
        <p className="setting-row-help">{help}</p>
      </div>
      <div
        style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flex: "1 1 22rem" }}
      >
        <input
          className="input"
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          style={{ fontSize: "0.8125rem" }}
        />
        <IconButton
          className="whitespace-nowrap"
          label="save"
          disabled={disabled}
          onClick={() => onSave(value)}
        />
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
  children: React.ReactNode;
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
