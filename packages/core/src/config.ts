/**
 * Configuration loading and defaults for loctx.
 *
 * Precedence (low → high):
 *
 *   1. Built-in defaults
 *   2. Global config — `$XDG_CONFIG_HOME/loctx/config.yaml`
 *   3. Environment overrides — `LOCTX_DATA_DIR`, `LOCTX_CONFIG_DIR`
 *
 * There are no flag-level config overrides. Per-invocation flags
 * (`--scope`, `--limit`, `--cwd`, `--no-watch`, …) are operational and
 * have no config equivalent. Persistent settings belong in a YAML file.
 *
 * Filtering rules live in their own overlay system loaded by `filtering.ts`
 * (`~/.loctx/config_overrides/*.yaml`). Do not duplicate filtering policy
 * here.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BOOL, INT_NON_NEG, STR, STR_ARRAY } from "./_validate.js";
import { DEFAULT_QUALITY_THRESHOLDS } from "./analyzers/quality.js";
import {
  ConfigError,
  type ConfigSource,
  makePicker,
  mergeSection,
  type SectionField,
  sectionRecord,
} from "./config-merge.js";
import {
  defaultPaths,
  ensurePaths,
  type PathOrigin,
  pathOrigin,
  type StoragePaths,
} from "./paths.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_DAEMON_PORT = 3022;
// `127.0.0.1` rather than `localhost` so the daemon binds to a literal
// loopback IP. Browsers refuse to rebind a literal IP via DNS, which
// shuts down the DNS-rebinding attack against the localhost daemon.
// Users can override to `localhost` or `0.0.0.0` in config if they
// understand the trade-off.
const DEFAULT_DAEMON_HOSTNAME = "127.0.0.1";
/**
 * Legacy project-level config filename. The project layer was dropped in
 * favor of a single global `config.yaml` editable through the admin UI;
 * `start.ts` still scans for this name to print a one-time deprecation
 * warning if a user has one lying around.
 */

export interface EmbeddingConfig {
  readonly provider: string;
  readonly model: string;
  readonly normalize: boolean;
  /**
   * Run-time override sourced from `LOCTX_EMBEDDING_PROVIDER`. When set to
   * `"fake"` the container substitutes the deterministic fake provider; any
   * other value defers to `provider`/`model`. Read once at `loadConfig` so
   * `buildRuntime(config)` is fully derivable from `Config`.
   */
  readonly providerOverride?: string;
}

export interface WatcherConfig {
  readonly debounceMs: number;
}

export interface DaemonConfig {
  readonly port: number;
  readonly hostname: string;
}

/**
 * Which retrieval branches the searcher fires.
 *   - `hybrid`  — both vector (LanceDB) and lexical (FTS5/BM25) in parallel,
 *                 fused via reciprocal rank fusion. Default; best quality.
 *   - `vector`  — vector branch only. For benchmarks or when FTS5 is broken.
 *   - `lexical` — BM25 only. Cheaper at query time; no embedding required.
 */
export type RetrievalMode = "hybrid" | "vector" | "lexical";

export interface RetrievalConfig {
  readonly mode: RetrievalMode;
  /** Reciprocal Rank Fusion constant. Literature default is 60. */
  readonly rrfK: number;
}

/**
 * Background analyzer enrichment (#61): out-of-band runners for heavy
 * analyzers (Lizard, Semgrep, clone detection) that must not block the
 * watcher or search. Disabled by default; individual analyzers opt in
 * via their own config sections.
 */
export interface AnalyzerConfig {
  /** Master switch. When false, no background tasks run regardless of analyzer config. */
  readonly backgroundEnabled: boolean;
  /** Max concurrent background runners. */
  readonly concurrency: number;
  /** Per-task timeout in milliseconds. */
  readonly perTaskTimeoutMs: number;
  /** Lizard complexity analyzer (#62). */
  readonly lizard: LizardAnalyzerConfig;
  /** Duplicate-code detector (#65). Pure-JS token-window hashing, no external deps. */
  readonly duplicates: DuplicatesAnalyzerConfig;
  /** Semgrep CE rule-pack analyzer (#64). External binary, opt-in. */
  readonly semgrep: RulePackAnalyzerConfig;
  /** ast-grep rule-pack analyzer (#64). External binary, opt-in. */
  readonly astGrep: RulePackAnalyzerConfig;
  /** Definition validator (#okf) — schema-checks agent/skill/knowledge .md. */
  readonly definitions: DefinitionsAnalyzerConfig;
  /** Heuristic quality analyzer (#522). Pure-JS rules over indexed signals. */
  readonly quality: QualityAnalyzerConfig;
}

/**
 * Heuristic code-quality rules (#522) computed from data the index
 * already holds (AST metadata, lizard metrics, symbol refs). Pure JS,
 * no external binary. The threshold fields mirror
 * `analyzers/quality.ts`'s QualityThresholds one-to-one.
 */
export interface QualityAnalyzerConfig {
  /** Opt-out. Enabled by default — the rules are cheap local reads. */
  readonly enabled: boolean;
  /** `god-file` fires when non-empty lines AND exports both exceed their thresholds. */
  readonly godFileNloc: number;
  readonly godFileExports: number;
  /** `long-params`: flag functions with more parameters than this. */
  readonly maxParams: number;
  /** `deep-nesting`: flag chunks nested at or beyond this depth. */
  readonly maxNestingDepth: number;
  /** `deep-nesting` escalates to warning when overlapping CCN exceeds this. */
  readonly escalateCcn: number;
  /** `high-fan-out`: flag files importing from more modules than this. */
  readonly maxFanOut: number;
  /** `high-fan-in`: flag files referenced by more files than this. */
  readonly maxFanIn: number;
  /** Cap on findings persisted per file. */
  readonly maxFindingsPerFile: number;
  /** Markdown context rules (#527): stale-ref + doc-drift for indexed .md. */
  readonly markdownRules: boolean;
  /**
   * `doc-drift` cosine floor as a percent (35 → 0.35). Evaluated at
   * query time by the quality report (#525) — cross-file signal.
   */
  readonly docDriftFloor: number;
}

/**
 * Validates the YAML frontmatter of markdown "definition" files (agents,
 * skills, OKF concept docs) against JSON Schemas. No external binary — pure
 * ajv. The bundled OKF v0.1 default needs no setup.
 */
export interface DefinitionsAnalyzerConfig {
  /** Opt-in like the others; gated by `background_enabled`. */
  readonly enabled: boolean;
  /** Apply the bundled OKF v0.1 schema in addition to any custom schemas. */
  readonly okfDefault: boolean;
  /** Project-relative globs selecting which .md files are "definitions". */
  readonly globs: ReadonlyArray<string>;
  /** Extra JSON Schema sources (local paths; URLs handled by the UI layer). */
  readonly schemas: ReadonlyArray<string>;
  /** When true, a matched file with no frontmatter at all is an error. */
  readonly requireFrontmatter: boolean;
  /** When true, flag relative markdown links that don't resolve to a file. */
  readonly checkLinks: boolean;
  /** Cap on findings persisted per file. */
  readonly maxFindingsPerFile: number;
}

export interface LizardAnalyzerConfig {
  /** Opt-in. False by default; runs only when both this and `analyzers.background_enabled` are true. */
  readonly enabled: boolean;
  /** Command to invoke. Defaults to `lizard` on PATH. Override for venv installs or full paths. */
  readonly command: string;
}

export interface DuplicatesAnalyzerConfig {
  /** Opt-in. False by default. */
  readonly enabled: boolean;
  /** Tokens per sliding window. Larger = fewer false positives, more missed clones. */
  readonly windowSize: number;
  /** Minimum distinct tokens required for a window to count. Filters boilerplate. */
  readonly minUniqueTokens: number;
  /**
   * Include embedding-based near-duplicate groups in `find_duplicates`
   * (#523). Query-time only — reads vectors the index already stores;
   * nothing extra runs during indexing. Off by default in v1.
   */
  readonly semantic: boolean;
  /**
   * Cosine-similarity floor for a semantic pair, as a PERCENT (92 →
   * 0.92). Integer because config leaves are int/bool/string only.
   */
  readonly semanticThreshold: number;
  /**
   * Row cap on the vector scan feeding the pairwise pass. The response
   * flags `truncated` when hit — bigger finds more at O(n²) cost.
   */
  readonly semanticMaxChunks: number;
}

/**
 * Shared shape for rule-pack analyzers (Semgrep, ast-grep). Both shell
 * out to an external binary, accept rule directories or files, and need
 * a per-file finding cap so a noisy rule pack can't blow up storage.
 */
export interface RulePackAnalyzerConfig {
  /** Opt-in. False by default; runs only when both this and `analyzers.background_enabled` are true. */
  readonly enabled: boolean;
  /** Command to invoke. Override for venv installs or full paths. */
  readonly command: string;
  /** Rule directories or files passed to the runner. Empty disables. */
  readonly ruleDirs: ReadonlyArray<string>;
  /**
   * Fallback ruleset used when `ruleDirs` is empty — a semgrep registry
   * reference like `p/default` (a curated community pack) so semgrep works
   * with zero local config. Blank disables the fallback (the analyzer is
   * then inert without `ruleDirs`). semgrep only; ast-grep has no registry
   * and ignores this.
   */
  readonly registryConfig: string;
  /**
   * Use loctx's bundled starter rules when `ruleDirs` is empty. ast-grep has
   * no community registry, so this ships a small high-signal default set so
   * the analyzer isn't a dead-end out of the box. ast-grep only; semgrep
   * (which has a registry) ignores it.
   */
  readonly bundledRules: boolean;
  /** Cap on findings persisted per file. Excess findings are dropped. */
  readonly maxFindingsPerFile: number;
}

/**
 * Reconciliation behavior (#14): catches up the index after the daemon
 * was offline (deleted/modified files) and trims drift over time.
 *
 *   - `runOnStart`        run a full pass once after watcher startup. Default true.
 *   - `intervalSeconds`   periodic scan cadence. 0 disables. Default 600 (10 min).
 */
export interface ReconciliationConfig {
  readonly runOnStart: boolean;
  readonly intervalSeconds: number;
}

/**
 * Background index maintenance (#index-size). The vector store is
 * append-only — every upsert/delete writes a new Lance fragment + version
 * manifest, and the old history is never reclaimed on its own. A periodic
 * compaction merges fragments and prunes that history so a long-lived
 * daemon doesn't accumulate gigabytes of dead version data.
 *
 *   - `compactIntervalHours`  cadence of the auto-compaction pass. 0
 *                             disables it (the manual admin button still
 *                             works). Default 24 (once a day).
 */
export interface MaintenanceConfig {
  readonly compactIntervalHours: number;
}

/**
 * Project discovery (#81). Walks `workspace_roots` looking for marker
 * files/directories that identify a project root.
 *
 *   - `extraMarkers`  additional filenames recognized as project markers,
 *                     beyond the built-in defaults. All classified as
 *                     "build" tier (lower confidence than `.git` /
 *                     `.idea` / `.vscode`).
 *   - `maxDepth`      walk-depth cap. Default 4.
 */
export interface DiscoveryConfig {
  readonly extraMarkers: ReadonlyArray<string>;
  readonly maxDepth: number;
}

/**
 * MCP server behaviour.
 *
 *   - `logMaxRows`     rolling row cap on the `mcp_requests` table. Each
 *                      `tools/call` is appended and the oldest rows are
 *                      trimmed back to this many. Default 200. Set to `0`
 *                      to disable request logging entirely.
 *   - `adminEnabled`   expose the `admin_workspace` MCP tool, which lets a
 *                      connected LLM run maintenance (compact, analyzer
 *                      backfill) and read/write the daemon config. OFF by
 *                      default — it's a privileged surface; opt in only if
 *                      you trust whatever's on the MCP channel.
 */
export interface McpConfig {
  readonly logMaxRows: number;
  readonly adminEnabled: boolean;
}

/**
 * Outbound-network settings for environments behind a TLS-intercepting
 * proxy or corporate firewall (#385). Applied to runtime fetches (the
 * embedding-model download) and passed to subprocesses (future
 * `loctx update`, optional-tool installs).
 */
export interface NetworkConfig {
  /** Path to an extra CA cert PEM to trust (e.g. a corporate/Socket root CA). null = none. */
  readonly caCert: string | null;
  /** When false, TLS certificate verification is disabled. Insecure; last resort. */
  readonly strictSsl: boolean;
  /** HTTP(S) proxy URL for outbound requests. null = direct. */
  readonly proxy: string | null;
}

/** Where each leaf came from. Keyed by dot-path (e.g. "embedding.model"). */
export type ConfigSources = Readonly<Record<string, ConfigSource>>;

export interface Config {
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly paths: StoragePaths;
  readonly embedding: EmbeddingConfig;
  readonly watcher: WatcherConfig;
  readonly daemon: DaemonConfig;
  readonly retrieval: RetrievalConfig;
  readonly reconciliation: ReconciliationConfig;
  readonly maintenance: MaintenanceConfig;
  readonly discovery: DiscoveryConfig;
  readonly analyzers: AnalyzerConfig;
  readonly mcp: McpConfig;
  readonly network: NetworkConfig;
  /** Path of the global YAML if loaded; null when only defaults applied. */
  readonly source: string | null;
  readonly sources: ConfigSources;
}

const DEFAULT_EMBEDDING: EmbeddingConfig = Object.freeze({
  provider: "huggingface-transformers",
  model: "Xenova/all-MiniLM-L6-v2",
  normalize: true,
});

const DEFAULT_WATCHER: WatcherConfig = Object.freeze({
  debounceMs: DEFAULT_DEBOUNCE_MS,
});

const DEFAULT_DAEMON: DaemonConfig = Object.freeze({
  port: DEFAULT_DAEMON_PORT,
  hostname: DEFAULT_DAEMON_HOSTNAME,
});

const DEFAULT_RRF_K = 60;
const DEFAULT_RETRIEVAL: RetrievalConfig = Object.freeze({
  mode: "hybrid",
  rrfK: DEFAULT_RRF_K,
});

const DEFAULT_DISCOVERY: DiscoveryConfig = Object.freeze({
  extraMarkers: Object.freeze<string[]>([]),
  maxDepth: 4,
});

const DEFAULT_RECONCILIATION: ReconciliationConfig = Object.freeze({
  runOnStart: true,
  intervalSeconds: 600,
});

const DEFAULT_MAINTENANCE: MaintenanceConfig = Object.freeze({
  compactIntervalHours: 24,
});

const DEFAULT_MCP_LOG_MAX_ROWS = 200;
const DEFAULT_MCP: McpConfig = Object.freeze({
  logMaxRows: DEFAULT_MCP_LOG_MAX_ROWS,
  adminEnabled: false,
});

const DEFAULT_NETWORK: NetworkConfig = Object.freeze({
  caCert: null,
  strictSsl: true,
  proxy: null,
});

// Analyzers ship ENABLED by default so the tool is useful out of the box.
// The background queue runs; `duplicates` (pure-JS, zero-dep) works
// immediately. `lizard`/`semgrep`/`ast-grep` shell out to external
// binaries — they're enabled too, but the indexer probes for the command
// and silently skips enqueuing when it's absent (see container.ts), so
// "enabled" means "runs when the tool is installed" rather than spamming
// a failed task per file. semgrep/ast-grep additionally need rule dirs.
const DEFAULT_ANALYZERS: AnalyzerConfig = Object.freeze({
  backgroundEnabled: true,
  concurrency: 2,
  perTaskTimeoutMs: 60_000,
  lizard: Object.freeze({ enabled: true, command: "lizard" }),
  duplicates: Object.freeze({
    enabled: true,
    windowSize: 50,
    minUniqueTokens: 15,
    semantic: false,
    semanticThreshold: 92,
    semanticMaxChunks: 3000,
  }),
  semgrep: Object.freeze({
    enabled: true,
    command: "semgrep",
    ruleDirs: Object.freeze<string[]>([]),
    // Curated community pack — semgrep runs this when no local ruleDirs are
    // set, so it produces findings out of the box (needs network to fetch).
    registryConfig: "p/default",
    bundledRules: false,
    maxFindingsPerFile: 50,
  }),
  astGrep: Object.freeze({
    enabled: true,
    command: "ast-grep",
    ruleDirs: Object.freeze<string[]>([]),
    // ast-grep has no rule registry; loctx ships a starter set instead.
    registryConfig: "",
    bundledRules: true,
    maxFindingsPerFile: 50,
  }),
  definitions: Object.freeze({
    enabled: true,
    okfDefault: true,
    // Conventional agent/skill/knowledge definition files — not generic docs.
    globs: Object.freeze<string[]>([
      ".claude/skills/**/*.md",
      ".claude/agents/**/*.md",
      ".cursor/rules/**/*.md",
      "**/SKILL.md",
      "AGENTS.md",
      "**/*.okf.md",
    ]),
    schemas: Object.freeze<string[]>([]),
    requireFrontmatter: false,
    checkLinks: true,
    maxFindingsPerFile: 50,
  }),
  // Thresholds come from the analyzer's own DEFAULT_QUALITY_THRESHOLDS
  // so the shipped defaults and the rule module can't drift.
  quality: Object.freeze({
    enabled: true,
    ...DEFAULT_QUALITY_THRESHOLDS,
    maxFindingsPerFile: 50,
    markdownRules: true,
    docDriftFloor: 35,
  }),
});

const VALID_RETRIEVAL_MODES: ReadonlySet<RetrievalMode> = Object.freeze(
  new Set<RetrievalMode>(["hybrid", "vector", "lexical"]),
);

export function defaultConfigYaml(): string {
  return join(dirname(defaultPaths().configDir), "loctx", "config.yaml");
}

export interface LoadConfigOptions {
  /** Override the global config path. Defaults to `<configDir>/config.yaml`. */
  readonly configPath?: string;
}

/**
 * Load the global config and stamp every leaf's source. The project-level
 * layer was removed in favor of a single global YAML editable from the
 * admin UI — `start.ts` warns separately when it finds a stray
 * `.loctx.yaml` so users know to migrate.
 *
 * Backward-compat: passing a string is interpreted as `{ configPath }`,
 * the pre-layered call shape.
 */
export function loadConfig(options?: string | LoadConfigOptions): Config {
  const opts: LoadConfigOptions =
    typeof options === "string" ? { configPath: options } : (options ?? {});

  // Read every LOCTX_* env var once; nothing downstream consults process.env.
  const env = readLoctxEnv();
  const origin = pathOrigin();
  const paths = defaultPaths();
  ensurePaths(paths);

  const globalPath = opts.configPath ?? join(paths.configDir, "config.yaml");
  const globalRaw = readYamlOrNull(globalPath);

  rejectFilteringSection(globalRaw, globalPath);

  const sources: Record<string, ConfigSource> = {};
  const merged = mergeFields(globalRaw, env, sources);

  for (const [k, v] of Object.entries(sourcesForPaths(origin))) sources[k] = v;

  return Object.freeze({
    workspaceRoots: merged.workspaceRoots,
    paths,
    embedding: merged.embedding,
    watcher: merged.watcher,
    daemon: merged.daemon,
    retrieval: merged.retrieval,
    reconciliation: merged.reconciliation,
    maintenance: merged.maintenance,
    discovery: merged.discovery,
    analyzers: merged.analyzers,
    mcp: merged.mcp,
    network: merged.network,
    source: globalRaw === null ? null : globalPath,
    sources: Object.freeze(sources),
  });
}

interface LoctxEnv {
  readonly embeddingProvider: string | undefined;
}

function readLoctxEnv(): LoctxEnv {
  const raw = process.env["LOCTX_EMBEDDING_PROVIDER"];
  return { embeddingProvider: raw && raw.length > 0 ? raw : undefined };
}

// ---- parsing -----------------------------------------------------------

function readYamlOrNull(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    // `merge: false` disables YAML merge keys (`<<`) and `maxAliasCount`
    // caps alias resolution to defend against billion-laughs-style
    // YAML bombs. Both matter because the global config and the
    // filtering overlay are user-editable files; a hostile (or just
    // malformed) one shouldn't be able to DoS the loader. See #179.
    raw = parseYaml(readFileSync(path, "utf-8"), { merge: false, maxAliasCount: 100 });
  } catch (err) {
    throw new ConfigError(`Could not parse ${path}: ${(err as Error).message}`);
  }
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${path}: top-level YAML must be a mapping.`);
  }
  return raw as Record<string, unknown>;
}

function rejectFilteringSection(raw: Record<string, unknown> | null, source: string): void {
  if (raw === null) return;
  if ("filtering" in raw || "indexing" in raw) {
    throw new ConfigError(
      `${source}: filtering rules live in YAML at ~/.loctx/config_overrides/*.yaml — remove \`filtering\` / \`indexing\` sections from this file.`,
    );
  }
}

// ---- merge -------------------------------------------------------------

interface MergedFields {
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly embedding: EmbeddingConfig;
  readonly watcher: WatcherConfig;
  readonly daemon: DaemonConfig;
  readonly retrieval: RetrievalConfig;
  readonly reconciliation: ReconciliationConfig;
  readonly maintenance: MaintenanceConfig;
  readonly discovery: DiscoveryConfig;
  readonly analyzers: AnalyzerConfig;
  readonly mcp: McpConfig;
  readonly network: NetworkConfig;
}

function mergeFields(
  global: Record<string, unknown> | null,
  env: LoctxEnv,
  sources: Record<string, ConfigSource>,
): MergedFields {
  const pickRoot = makePicker(global, sources);
  return {
    workspaceRoots: pickRoot("workspaceRoots", "workspace_roots", STR_ARRAY, [process.cwd()]),
    embedding: mergeEmbedding(global, env, sources),
    watcher: mergeWatcher(global, sources),
    daemon: mergeDaemon(global, sources),
    retrieval: mergeRetrieval(global, sources),
    reconciliation: mergeReconciliation(global, sources),
    maintenance: mergeMaintenance(global, sources),
    discovery: mergeDiscovery(global, sources),
    analyzers: mergeAnalyzers(global, sources),
    mcp: mergeMcp(global, sources),
    network: mergeNetwork(global, sources),
  };
}

function mergeMcp(
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): McpConfig {
  const pick = makePicker(sectionRecord(global, "mcp", "<global>"), sources);
  return Object.freeze({
    logMaxRows: pick("mcp.logMaxRows", "log_max_rows", INT_NON_NEG, DEFAULT_MCP.logMaxRows),
    adminEnabled: pick("mcp.adminEnabled", "admin_enabled", BOOL, DEFAULT_MCP.adminEnabled),
  });
}

function mergeNetwork(
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): NetworkConfig {
  const pick = makePicker(sectionRecord(global, "network", "<global>"), sources);
  // Nullable strings: empty/unset → null (the picker's generic fallback
  // must match the spec's value type, so default to "" and map after).
  const caCert = pick("network.caCert", "ca_cert", STR, "");
  const proxy = pick("network.proxy", "proxy", STR, "");
  return Object.freeze({
    caCert: caCert === "" ? null : caCert,
    strictSsl: pick("network.strictSsl", "strict_ssl", BOOL, DEFAULT_NETWORK.strictSsl),
    proxy: proxy === "" ? null : proxy,
  });
}

function mergeEmbedding(
  global: Record<string, unknown> | null,
  env: LoctxEnv,
  sources: Record<string, ConfigSource>,
): EmbeddingConfig {
  const gloE = sectionRecord(global, "embedding", "<global>");
  const pick = makePicker(gloE, sources);
  const base = {
    provider: pick("embedding.provider", "provider", STR, DEFAULT_EMBEDDING.provider),
    model: pick("embedding.model", "model", STR, DEFAULT_EMBEDDING.model),
    normalize: pick("embedding.normalize", "normalize", BOOL, DEFAULT_EMBEDDING.normalize),
  };
  if (env.embeddingProvider !== undefined) {
    sources["embedding.providerOverride"] = "env";
    return Object.freeze({ ...base, providerOverride: env.embeddingProvider });
  }
  return Object.freeze(base);
}

function mergeWatcher(
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): WatcherConfig {
  const pick = makePicker(sectionRecord(global, "watcher", "<global>"), sources);
  return Object.freeze({
    debounceMs: pick("watcher.debounceMs", "debounce_ms", INT_NON_NEG, DEFAULT_WATCHER.debounceMs),
  });
}

function mergeDaemon(
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): DaemonConfig {
  const pick = makePicker(sectionRecord(global, "daemon", "<global>"), sources);
  return Object.freeze({
    port: pick("daemon.port", "port", INT_NON_NEG, DEFAULT_DAEMON.port),
    hostname: pick("daemon.hostname", "hostname", STR, DEFAULT_DAEMON.hostname),
  });
}

function mergeRetrieval(
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): RetrievalConfig {
  const pick = makePicker(sectionRecord(global, "retrieval", "<global>"), sources);
  const modeStr = pick("retrieval.mode", "mode", STR, DEFAULT_RETRIEVAL.mode);
  if (!VALID_RETRIEVAL_MODES.has(modeStr as RetrievalMode)) {
    throw new ConfigError(
      `retrieval.mode must be one of ${[...VALID_RETRIEVAL_MODES].join(", ")} (got '${modeStr}')`,
    );
  }
  return Object.freeze({
    mode: modeStr as RetrievalMode,
    rrfK: pick("retrieval.rrfK", "rrf_k", INT_NON_NEG, DEFAULT_RETRIEVAL.rrfK),
  });
}

function mergeReconciliation(
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): ReconciliationConfig {
  const pick = makePicker(sectionRecord(global, "reconciliation", "<global>"), sources);
  return Object.freeze({
    runOnStart: pick(
      "reconciliation.runOnStart",
      "run_on_start",
      BOOL,
      DEFAULT_RECONCILIATION.runOnStart,
    ),
    intervalSeconds: pick(
      "reconciliation.intervalSeconds",
      "interval_seconds",
      INT_NON_NEG,
      DEFAULT_RECONCILIATION.intervalSeconds,
    ),
  });
}

function mergeMaintenance(
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): MaintenanceConfig {
  const pick = makePicker(sectionRecord(global, "maintenance", "<global>"), sources);
  return Object.freeze({
    compactIntervalHours: pick(
      "maintenance.compactIntervalHours",
      "compact_interval_hours",
      INT_NON_NEG,
      DEFAULT_MAINTENANCE.compactIntervalHours,
    ),
  });
}

function mergeDiscovery(
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): DiscoveryConfig {
  const pick = makePicker(sectionRecord(global, "discovery", "<global>"), sources);
  return Object.freeze({
    extraMarkers: Object.freeze(
      pick("discovery.extraMarkers", "extra_markers", STR_ARRAY, [
        ...DEFAULT_DISCOVERY.extraMarkers,
      ]),
    ),
    maxDepth: pick("discovery.maxDepth", "max_depth", INT_NON_NEG, DEFAULT_DISCOVERY.maxDepth),
  });
}

/**
 * Fields shared by both rule-pack analyzers (semgrep, ast-grep). Each
 * analyzer appends its own extra: semgrep picks `registryConfig` (the
 * registry fallback ruleset), ast-grep picks `bundledRules` (loctx's
 * starter set — ast-grep has no registry).
 */
const RULE_PACK_FIELDS: ReadonlyArray<SectionField<RulePackAnalyzerConfig>> = [
  { key: "enabled", kind: "bool" },
  { key: "command", kind: "str" },
  { key: "ruleDirs", kind: "strArray" },
  { key: "maxFindingsPerFile", kind: "int" },
];

function mergeAnalyzers(
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): AnalyzerConfig {
  const gloA = sectionRecord(global, "analyzers", "<global>");
  const section = (name: string): Record<string, unknown> | null =>
    sectionRecord(gloA, name, "<global>");
  const pick = makePicker(gloA, sources);
  return Object.freeze({
    backgroundEnabled: pick(
      "analyzers.backgroundEnabled",
      "background_enabled",
      BOOL,
      DEFAULT_ANALYZERS.backgroundEnabled,
    ),
    concurrency: pick(
      "analyzers.concurrency",
      "concurrency",
      INT_NON_NEG,
      DEFAULT_ANALYZERS.concurrency,
    ),
    perTaskTimeoutMs: pick(
      "analyzers.perTaskTimeoutMs",
      "per_task_timeout_ms",
      INT_NON_NEG,
      DEFAULT_ANALYZERS.perTaskTimeoutMs,
    ),
    lizard: mergeSection(section("lizard"), sources, "analyzers.lizard", DEFAULT_ANALYZERS.lizard, [
      { key: "enabled", kind: "bool" },
      { key: "command", kind: "str" },
    ]),
    duplicates: mergeSection(
      section("duplicates"),
      sources,
      "analyzers.duplicates",
      DEFAULT_ANALYZERS.duplicates,
      [
        { key: "enabled", kind: "bool" },
        { key: "windowSize", kind: "int" },
        { key: "minUniqueTokens", kind: "int" },
        { key: "semantic", kind: "bool" },
        { key: "semanticThreshold", kind: "int" },
        { key: "semanticMaxChunks", kind: "int" },
      ],
    ),
    semgrep: mergeSection(
      section("semgrep"),
      sources,
      "analyzers.semgrep",
      DEFAULT_ANALYZERS.semgrep,
      [...RULE_PACK_FIELDS, { key: "registryConfig", kind: "str" }],
    ),
    astGrep: mergeSection(
      // Accept both `astGrep:` (camelCase, matches the config template)
      // and `ast_grep:` (snake_case, matches every other YAML key).
      section("astGrep") ?? section("ast_grep"),
      sources,
      "analyzers.astGrep",
      DEFAULT_ANALYZERS.astGrep,
      [...RULE_PACK_FIELDS, { key: "bundledRules", kind: "bool" }],
    ),
    definitions: mergeSection(
      section("definitions"),
      sources,
      "analyzers.definitions",
      DEFAULT_ANALYZERS.definitions,
      [
        { key: "enabled", kind: "bool" },
        { key: "okfDefault", kind: "bool" },
        { key: "globs", kind: "strArray" },
        { key: "schemas", kind: "strArray" },
        { key: "requireFrontmatter", kind: "bool" },
        { key: "checkLinks", kind: "bool" },
        { key: "maxFindingsPerFile", kind: "int" },
      ],
    ),
    quality: mergeSection(
      section("quality"),
      sources,
      "analyzers.quality",
      DEFAULT_ANALYZERS.quality,
      [
        { key: "enabled", kind: "bool" },
        { key: "godFileNloc", kind: "int" },
        { key: "godFileExports", kind: "int" },
        { key: "maxParams", kind: "int" },
        { key: "maxNestingDepth", kind: "int" },
        { key: "escalateCcn", kind: "int" },
        { key: "maxFanOut", kind: "int" },
        { key: "maxFanIn", kind: "int" },
        { key: "maxFindingsPerFile", kind: "int" },
        { key: "markdownRules", kind: "bool" },
        { key: "docDriftFloor", kind: "int" },
      ],
    ),
  });
}

function sourcesForPaths(origin: PathOrigin): Record<string, ConfigSource> {
  return {
    "paths.dataDir": origin.dataDirFromEnv ? "env" : "default",
    "paths.configDir": origin.configDirFromEnv ? "env" : "default",
    // Remaining path fields are derived from dataDir; `config show` formats
    // them as "(derived)" so listing them here would be noise.
  };
}

export {
  findLegacyProjectConfig,
  LEGACY_PROJECT_CONFIG_FILENAME,
  summarizeLegacyProjectConfig,
} from "./config-legacy.js";
// Re-exports: these moved out in the #542 split; existing importers
// keep working through config.ts.
export { ConfigError, type ConfigSource } from "./config-merge.js";
export { CONFIG_TEMPLATE } from "./config-template.js";
