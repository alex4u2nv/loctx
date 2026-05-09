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
import { BOOL, INT_NON_NEG, STR, Validator } from "./_validate.js";
import { type StoragePaths, defaultPaths, ensurePaths } from "./paths.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_DAEMON_PORT = 3000;
const DEFAULT_DAEMON_HOSTNAME = "localhost";
const PROJECT_CONFIG_FILENAME = ".loctx.yaml";

export interface EmbeddingConfig {
  readonly provider: string;
  readonly model: string;
  readonly normalize: boolean;
}

export interface WatcherConfig {
  readonly debounceMs: number;
}

export interface DaemonConfig {
  readonly port: number;
  readonly hostname: string;
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

  const paths = defaultPaths();
  ensurePaths(paths);

  const globalPath = opts.configPath ?? join(paths.configDir, "config.yaml");
  const projectPath = findProjectConfig(opts.cwd ?? process.cwd());

  const globalRaw = readYamlOrNull(globalPath);
  const projectRaw = projectPath !== null ? readYamlOrNull(projectPath) : null;

  rejectFilteringSection(globalRaw, globalPath);
  if (projectPath !== null) rejectFilteringSection(projectRaw, projectPath);

  const sources: Record<string, ConfigSource> = {};
  const merged = mergeFields(globalRaw, projectRaw, sources);

  const pathSources = sourcesForPaths(paths);
  for (const [k, v] of Object.entries(pathSources)) sources[k] = v;

  return Object.freeze({
    workspaceRoots: merged.workspaceRoots,
    paths,
    embedding: merged.embedding,
    watcher: merged.watcher,
    daemon: merged.daemon,
    source: globalRaw === null ? null : globalPath,
    projectSource: projectRaw === null ? null : projectPath,
    sources: Object.freeze(sources),
  });
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
}

function mergeFields(
  global: Record<string, unknown> | null,
  project: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): MergedFields {
  return {
    workspaceRoots: pickArray(
      "workspaceRoots",
      project,
      global,
      "workspace_roots",
      [process.cwd()],
      sources,
    ),
    embedding: mergeEmbedding(project, global, sources),
    watcher: mergeWatcher(project, global, sources),
    daemon: mergeDaemon(project, global, sources),
  };
}

function mergeEmbedding(
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): EmbeddingConfig {
  const projE = sectionRecord(project, "embedding", "<project>");
  const gloE = sectionRecord(global, "embedding", "<global>");
  return Object.freeze({
    provider: pickStr(
      "embedding.provider",
      projE,
      gloE,
      "provider",
      DEFAULT_EMBEDDING.provider,
      sources,
    ),
    model: pickStr("embedding.model", projE, gloE, "model", DEFAULT_EMBEDDING.model, sources),
    normalize: pickBool(
      "embedding.normalize",
      projE,
      gloE,
      "normalize",
      DEFAULT_EMBEDDING.normalize,
      sources,
    ),
  });
}

function mergeWatcher(
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): WatcherConfig {
  const projW = sectionRecord(project, "watcher", "<project>");
  const gloW = sectionRecord(global, "watcher", "<global>");
  return Object.freeze({
    debounceMs: pickIntNonNeg(
      "watcher.debounceMs",
      projW,
      gloW,
      "debounce_ms",
      DEFAULT_WATCHER.debounceMs,
      sources,
    ),
  });
}

function mergeDaemon(
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): DaemonConfig {
  const projD = sectionRecord(project, "daemon", "<project>");
  const gloD = sectionRecord(global, "daemon", "<global>");
  return Object.freeze({
    port: pickIntNonNeg("daemon.port", projD, gloD, "port", DEFAULT_DAEMON.port, sources),
    hostname: pickStr("daemon.hostname", projD, gloD, "hostname", DEFAULT_DAEMON.hostname, sources),
  });
}

// ---- per-leaf pickers --------------------------------------------------

function pickStr(
  trackKey: string,
  proj: Record<string, unknown> | null,
  glo: Record<string, unknown> | null,
  yamlKey: string,
  fallback: string,
  sources: Record<string, ConfigSource>,
): string {
  const projVal =
    proj === null ? undefined : new Validator(ConfigError, "<project>").get(proj, yamlKey, STR);
  if (projVal !== undefined) {
    sources[trackKey] = "project";
    return projVal;
  }
  const gloVal =
    glo === null ? undefined : new Validator(ConfigError, "<global>").get(glo, yamlKey, STR);
  if (gloVal !== undefined) {
    sources[trackKey] = "global";
    return gloVal;
  }
  sources[trackKey] = "default";
  return fallback;
}

function pickBool(
  trackKey: string,
  proj: Record<string, unknown> | null,
  glo: Record<string, unknown> | null,
  yamlKey: string,
  fallback: boolean,
  sources: Record<string, ConfigSource>,
): boolean {
  const projVal =
    proj === null ? undefined : new Validator(ConfigError, "<project>").get(proj, yamlKey, BOOL);
  if (projVal !== undefined) {
    sources[trackKey] = "project";
    return projVal;
  }
  const gloVal =
    glo === null ? undefined : new Validator(ConfigError, "<global>").get(glo, yamlKey, BOOL);
  if (gloVal !== undefined) {
    sources[trackKey] = "global";
    return gloVal;
  }
  sources[trackKey] = "default";
  return fallback;
}

function pickIntNonNeg(
  trackKey: string,
  proj: Record<string, unknown> | null,
  glo: Record<string, unknown> | null,
  yamlKey: string,
  fallback: number,
  sources: Record<string, ConfigSource>,
): number {
  const projVal =
    proj === null
      ? undefined
      : new Validator(ConfigError, "<project>").get(proj, yamlKey, INT_NON_NEG);
  if (projVal !== undefined) {
    sources[trackKey] = "project";
    return projVal;
  }
  const gloVal =
    glo === null
      ? undefined
      : new Validator(ConfigError, "<global>").get(glo, yamlKey, INT_NON_NEG);
  if (gloVal !== undefined) {
    sources[trackKey] = "global";
    return gloVal;
  }
  sources[trackKey] = "default";
  return fallback;
}

function pickArray(
  trackKey: string,
  proj: Record<string, unknown> | null,
  glo: Record<string, unknown> | null,
  yamlKey: string,
  fallback: ReadonlyArray<string>,
  sources: Record<string, ConfigSource>,
): ReadonlyArray<string> {
  const projVal =
    proj === null ? undefined : new Validator(ConfigError, "<project>").getStrArray(proj, yamlKey);
  if (projVal !== undefined) {
    sources[trackKey] = "project";
    return projVal;
  }
  const gloVal =
    glo === null ? undefined : new Validator(ConfigError, "<global>").getStrArray(glo, yamlKey);
  if (gloVal !== undefined) {
    sources[trackKey] = "global";
    return gloVal;
  }
  sources[trackKey] = "default";
  return fallback;
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

function sourcesForPaths(paths: StoragePaths): Record<string, ConfigSource> {
  const out: Record<string, ConfigSource> = {};
  out["paths.dataDir"] = process.env["LOCTX_DATA_DIR"] ? "env" : "default";
  out["paths.configDir"] = process.env["LOCTX_CONFIG_DIR"] ? "env" : "default";
  // The remaining path fields are derived from dataDir; flagging them here
  // would just be redundant noise, so we omit them — `config show` formats
  // them as "(derived)".
  void paths;
  return out;
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
`;
