/**
 * Configuration loading and defaults for loctx.
 *
 * Precedence (low → high):
 *
 *   1. Built-in defaults
 *   2. Global config — `$XDG_CONFIG_HOME/loctx/config.yaml`
 *   3. Project config — `.loctx.yaml` discovered by walking up from `cwd`
 *      (stops at the filesystem root). Opt-in by file existence.
 *   4. Environment overrides — `LOCTX_DATA_DIR`, `LOCTX_CONFIG_DIR`
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
const DEFAULT_DAEMON_HOSTNAME = "localhost";
const PROJECT_CONFIG_FILENAME = ".loctx.yaml";

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

export type ConfigSource = "default" | "global" | "project" | "env";

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
  /** Path of the project YAML if discovered; null otherwise. */
  readonly projectSource: string | null;
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
  /** Working directory for project-file discovery. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/**
 * Load and merge the layered config.
 *
 * Backward-compat: passing a string is interpreted as `{ configPath }`, the
 * pre-layered call shape.
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
  const projectPath = findProjectConfig(opts.cwd ?? process.cwd());

  const globalRaw = readYamlOrNull(globalPath);
  const projectRaw = projectPath !== null ? readYamlOrNull(projectPath) : null;

  rejectFilteringSection(globalRaw, globalPath);
  if (projectPath !== null) rejectFilteringSection(projectRaw, projectPath);

  const sources: Record<string, ConfigSource> = {};
  const merged = mergeFields(globalRaw, projectRaw, env, sources);

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
    projectSource: projectRaw === null ? null : projectPath,
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

// ---- discovery + parsing -----------------------------------------------

function findProjectConfig(startCwd: string): string | null {
  let cur = resolve(startCwd);
  // Bound: walk ≤ 64 levels in case of weird symlinks. fs root halts naturally.
  for (let i = 0; i < 64; i += 1) {
    const candidate = join(cur, PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = parsePath(cur).dir;
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

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
  project: Record<string, unknown> | null,
  env: LoctxEnv,
  sources: Record<string, ConfigSource>,
): MergedFields {
  const pickRoot = makePicker(project, global, sources);
  return {
    workspaceRoots: pickRoot("workspaceRoots", "workspace_roots", STR_ARRAY, [process.cwd()]),
    embedding: mergeEmbedding(project, global, env, sources),
    watcher: mergeWatcher(project, global, sources),
    daemon: mergeDaemon(project, global, sources),
    retrieval: mergeRetrieval(project, global, sources),
    reconciliation: mergeReconciliation(project, global, sources),
    discovery: mergeDiscovery(project, global, sources),
    analyzers: mergeAnalyzers(project, global, sources),
  };
}

function mergeEmbedding(
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
  env: LoctxEnv,
  sources: Record<string, ConfigSource>,
): EmbeddingConfig {
  const projE = sectionRecord(project, "embedding", "<project>");
  const gloE = sectionRecord(global, "embedding", "<global>");
  const pick = makePicker(projE, gloE, sources);
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
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): WatcherConfig {
  const pick = makePicker(
    sectionRecord(project, "watcher", "<project>"),
    sectionRecord(global, "watcher", "<global>"),
    sources,
  );
  return Object.freeze({
    debounceMs: pick("watcher.debounceMs", "debounce_ms", INT_NON_NEG, DEFAULT_WATCHER.debounceMs),
  });
}

function mergeDaemon(
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): DaemonConfig {
  const pick = makePicker(
    sectionRecord(project, "daemon", "<project>"),
    sectionRecord(global, "daemon", "<global>"),
    sources,
  );
  return Object.freeze({
    port: pick("daemon.port", "port", INT_NON_NEG, DEFAULT_DAEMON.port),
    hostname: pick("daemon.hostname", "hostname", STR, DEFAULT_DAEMON.hostname),
  });
}

function mergeRetrieval(
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): RetrievalConfig {
  const pick = makePicker(
    sectionRecord(project, "retrieval", "<project>"),
    sectionRecord(global, "retrieval", "<global>"),
    sources,
  );
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
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): ReconciliationConfig {
  const pick = makePicker(
    sectionRecord(project, "reconciliation", "<project>"),
    sectionRecord(global, "reconciliation", "<global>"),
    sources,
  );
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
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): DiscoveryConfig {
  const pick = makePicker(
    sectionRecord(project, "discovery", "<project>"),
    sectionRecord(global, "discovery", "<global>"),
    sources,
  );
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
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): AnalyzerConfig {
  const projA = sectionRecord(project, "analyzers", "<project>");
  const gloA = sectionRecord(global, "analyzers", "<global>");
  const pick = makePicker(projA, gloA, sources);
  const lizardPick = makePicker(
    sectionRecord(projA, "lizard", "<project>"),
    sectionRecord(gloA, "lizard", "<global>"),
    sources,
  );
  const dupPick = makePicker(
    sectionRecord(projA, "duplicates", "<project>"),
    sectionRecord(gloA, "duplicates", "<global>"),
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
  });
}

// ---- per-leaf picker ---------------------------------------------------

/**
 * Curry the project/global mappings + the source-tracking record, then return
 * a generic picker that resolves a single leaf against any `Spec<T>`. Walks
 * project → global → fallback and stamps the source map as it goes.
 */
function makePicker(
  proj: Record<string, unknown> | null,
  glo: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
) {
  const projectV = new Validator(ConfigError, "<project>");
  const globalV = new Validator(ConfigError, "<global>");
  return <T>(trackKey: string, yamlKey: string, spec: Spec<T>, fallback: T): T => {
    const projVal = proj === null ? undefined : projectV.get(proj, yamlKey, spec);
    if (projVal !== undefined) {
      sources[trackKey] = "project";
      return projVal;
    }
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
# A project-level .loctx.yaml at any directory above your cwd takes precedence.

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
