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
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { BOOL, INT_NON_NEG, STR, STR_ARRAY, type Spec, Validator } from "./_validate.js";
import {
  type PathOrigin,
  type StoragePaths,
  defaultPaths,
  ensurePaths,
  pathOrigin,
} from "./paths.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_DAEMON_PORT = 3000;
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
export const LEGACY_PROJECT_CONFIG_FILENAME = ".loctx.yaml";

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

export type ConfigSource = "default" | "global" | "env";

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
  readonly discovery: DiscoveryConfig;
  readonly analyzers: AnalyzerConfig;
  /** Path of the global YAML if loaded; null when only defaults applied. */
  readonly source: string | null;
  readonly sources: ConfigSources;
}

export class ConfigError extends Error {}

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

const DEFAULT_ANALYZERS: AnalyzerConfig = Object.freeze({
  backgroundEnabled: false,
  concurrency: 2,
  perTaskTimeoutMs: 60_000,
  lizard: Object.freeze({ enabled: false, command: "lizard" }),
  duplicates: Object.freeze({
    enabled: false,
    windowSize: 50,
    minUniqueTokens: 15,
  }),
  semgrep: Object.freeze({
    enabled: false,
    command: "semgrep",
    ruleDirs: Object.freeze<string[]>([]),
    maxFindingsPerFile: 50,
  }),
  astGrep: Object.freeze({
    enabled: false,
    command: "ast-grep",
    ruleDirs: Object.freeze<string[]>([]),
    maxFindingsPerFile: 50,
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
    discovery: merged.discovery,
    analyzers: merged.analyzers,
    source: globalRaw === null ? null : globalPath,
    sources: Object.freeze(sources),
  });
}

/**
 * Walk up from `cwd` looking for a legacy `.loctx.yaml`. Returns the
 * first match (closest to cwd) or null. Used by the daemon to surface a
 * deprecation warning — the loader no longer reads these files.
 */
export function findLegacyProjectConfig(cwd: string): string | null {
  let cur = resolve(cwd);
  // Bound: walk ≤ 64 levels in case of weird symlinks. fs root halts naturally.
  for (let i = 0; i < 64; i += 1) {
    const candidate = join(cur, LEGACY_PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = parsePath(cur).dir;
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
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
    raw = parseYaml(readFileSync(path, "utf-8"));
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
  readonly discovery: DiscoveryConfig;
  readonly analyzers: AnalyzerConfig;
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
    discovery: mergeDiscovery(global, sources),
    analyzers: mergeAnalyzers(global, sources),
  };
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

function mergeAnalyzers(
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): AnalyzerConfig {
  const gloA = sectionRecord(global, "analyzers", "<global>");
  const pick = makePicker(gloA, sources);
  const lizardPick = makePicker(sectionRecord(gloA, "lizard", "<global>"), sources);
  const dupPick = makePicker(sectionRecord(gloA, "duplicates", "<global>"), sources);
  const semgrepPick = makePicker(sectionRecord(gloA, "semgrep", "<global>"), sources);
  const astGrepPick = makePicker(
    sectionRecord(gloA, "astGrep", "<global>") ?? sectionRecord(gloA, "ast_grep", "<global>"),
    sources,
  );
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
    lizard: Object.freeze({
      enabled: lizardPick(
        "analyzers.lizard.enabled",
        "enabled",
        BOOL,
        DEFAULT_ANALYZERS.lizard.enabled,
      ),
      command: lizardPick(
        "analyzers.lizard.command",
        "command",
        STR,
        DEFAULT_ANALYZERS.lizard.command,
      ),
    }),
    duplicates: Object.freeze({
      enabled: dupPick(
        "analyzers.duplicates.enabled",
        "enabled",
        BOOL,
        DEFAULT_ANALYZERS.duplicates.enabled,
      ),
      windowSize: dupPick(
        "analyzers.duplicates.windowSize",
        "window_size",
        INT_NON_NEG,
        DEFAULT_ANALYZERS.duplicates.windowSize,
      ),
      minUniqueTokens: dupPick(
        "analyzers.duplicates.minUniqueTokens",
        "min_unique_tokens",
        INT_NON_NEG,
        DEFAULT_ANALYZERS.duplicates.minUniqueTokens,
      ),
    }),
    semgrep: Object.freeze({
      enabled: semgrepPick(
        "analyzers.semgrep.enabled",
        "enabled",
        BOOL,
        DEFAULT_ANALYZERS.semgrep.enabled,
      ),
      command: semgrepPick(
        "analyzers.semgrep.command",
        "command",
        STR,
        DEFAULT_ANALYZERS.semgrep.command,
      ),
      ruleDirs: Object.freeze(
        semgrepPick("analyzers.semgrep.ruleDirs", "rule_dirs", STR_ARRAY, [
          ...DEFAULT_ANALYZERS.semgrep.ruleDirs,
        ]),
      ),
      maxFindingsPerFile: semgrepPick(
        "analyzers.semgrep.maxFindingsPerFile",
        "max_findings_per_file",
        INT_NON_NEG,
        DEFAULT_ANALYZERS.semgrep.maxFindingsPerFile,
      ),
    }),
    astGrep: Object.freeze({
      enabled: astGrepPick(
        "analyzers.astGrep.enabled",
        "enabled",
        BOOL,
        DEFAULT_ANALYZERS.astGrep.enabled,
      ),
      command: astGrepPick(
        "analyzers.astGrep.command",
        "command",
        STR,
        DEFAULT_ANALYZERS.astGrep.command,
      ),
      ruleDirs: Object.freeze(
        astGrepPick("analyzers.astGrep.ruleDirs", "rule_dirs", STR_ARRAY, [
          ...DEFAULT_ANALYZERS.astGrep.ruleDirs,
        ]),
      ),
      maxFindingsPerFile: astGrepPick(
        "analyzers.astGrep.maxFindingsPerFile",
        "max_findings_per_file",
        INT_NON_NEG,
        DEFAULT_ANALYZERS.astGrep.maxFindingsPerFile,
      ),
    }),
  });
}

// ---- per-leaf picker ---------------------------------------------------

/**
 * Curry the global mapping + the source-tracking record, then return a
 * generic picker that resolves a single leaf against any `Spec<T>`.
 * Walks global → fallback and stamps the source map as it goes.
 */
type PickFn = <T>(trackKey: string, yamlKey: string, spec: Spec<T>, fallback: T) => T;

function makePicker(
  glo: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): PickFn {
  const globalV = new Validator(ConfigError, "<global>");
  return <T>(trackKey: string, yamlKey: string, spec: Spec<T>, fallback: T): T => {
    const gloVal = glo === null ? undefined : globalV.get(glo, yamlKey, spec);
    if (gloVal !== undefined) {
      sources[trackKey] = "global";
      return gloVal;
    }
    sources[trackKey] = "default";
    return fallback;
  };
}

function sectionRecord(
  raw: Record<string, unknown> | null,
  key: string,
  source: string,
): Record<string, unknown> | null {
  if (raw === null) return null;
  const inner = raw[key];
  if (inner === undefined) return null;
  if (inner === null) return {};
  if (typeof inner !== "object" || Array.isArray(inner)) {
    throw new ConfigError(`${source}: section '${key}' must be a mapping.`);
  }
  return inner as Record<string, unknown>;
}

function sourcesForPaths(origin: PathOrigin): Record<string, ConfigSource> {
  return {
    "paths.dataDir": origin.dataDirFromEnv ? "env" : "default",
    "paths.configDir": origin.configDirFromEnv ? "env" : "default",
    // Remaining path fields are derived from dataDir; `config show` formats
    // them as "(derived)" so listing them here would be noise.
  };
}

// ---- template ----------------------------------------------------------

/**
 * Commented YAML template written by `loctx config init`. Every key is the
 * built-in default, surfaced so users can edit rather than discover.
 */
export const CONFIG_TEMPLATE = `# loctx global config — $XDG_CONFIG_HOME/loctx/config.yaml
# Edit here or via the admin UI; this is the single source of truth.

# Roots searched for projects (each top-level dir with a .git/ becomes a project).
# Defaults to process.cwd() when omitted.
# workspace_roots:
#   - ~/Workspaces

embedding:
  provider: huggingface-transformers
  model: Xenova/all-MiniLM-L6-v2
  normalize: true

watcher:
  debounce_ms: 500

daemon:
  port: 3000
  hostname: localhost

retrieval:
  # hybrid (default) | vector | lexical
  mode: hybrid
  # Reciprocal rank fusion constant; 60 is the literature default.
  rrf_k: 60
`;
