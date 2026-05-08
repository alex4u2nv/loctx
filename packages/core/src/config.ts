/**
 * Configuration loading and defaults for loctx.
 *
 * The main config lives at `$XDG_CONFIG_HOME/loctx/config.yaml` and covers
 * non-filtering settings (workspace roots, embedding, watcher). Filtering
 * rules live in YAML override files loaded by `filtering.ts` — do not
 * duplicate filtering policy here.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BOOL, INT_NON_NEG, STR, Validator } from "./_validate.js";
import { type StoragePaths, defaultPaths, ensurePaths } from "./paths.js";

const DEFAULT_DEBOUNCE_MS = 500;

/**
 * Default workspace roots when no config file is present: the current
 * working directory of whatever command launched loctx. Indexes "where
 * you start it." Override via `workspace_roots` in `config.yaml`.
 */
function defaultWorkspaceRoots(): ReadonlyArray<string> {
  return [process.cwd()];
}

export interface EmbeddingConfig {
  readonly provider: string;
  readonly model: string;
  readonly normalize: boolean;
}

export interface WatcherConfig {
  readonly debounceMs: number;
}

export interface Config {
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly paths: StoragePaths;
  readonly embedding: EmbeddingConfig;
  readonly watcher: WatcherConfig;
  readonly source: string | null;
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

export function defaultConfigYaml(): string {
  return join(dirname(defaultPaths().configDir), "loctx", "config.yaml");
}

export function loadConfig(path?: string): Config {
  const paths = defaultPaths();
  ensurePaths(paths);
  const configPath = path ?? join(paths.configDir, "config.yaml");

  if (!existsSync(configPath)) {
    return {
      workspaceRoots: defaultWorkspaceRoots(),
      paths,
      embedding: DEFAULT_EMBEDDING,
      watcher: DEFAULT_WATCHER,
      source: null,
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(configPath, "utf-8"));
  } catch (err) {
    throw new ConfigError(`Could not parse ${configPath}: ${(err as Error).message}`);
  }
  if (raw === null || raw === undefined) {
    return {
      workspaceRoots: defaultWorkspaceRoots(),
      paths,
      embedding: DEFAULT_EMBEDDING,
      watcher: DEFAULT_WATCHER,
      source: configPath,
    };
  }

  const v = new Validator(ConfigError, configPath);
  const data = v.requireRecord(raw, "top-level YAML");

  if ("filtering" in data || "indexing" in data) {
    throw new ConfigError(
      "Filtering rules now live in YAML at " +
        "~/.loctx/config_overrides/*.yaml — remove `filtering` / `indexing` " +
        "sections from config.yaml.",
    );
  }

  const roots = v.getStrArray(data, "workspace_roots") ?? defaultWorkspaceRoots();

  return {
    workspaceRoots: roots,
    paths,
    embedding: embeddingFrom(data["embedding"], configPath),
    watcher: watcherFrom(data["watcher"], configPath),
    source: configPath,
  };
}

function embeddingFrom(raw: unknown, source: string): EmbeddingConfig {
  if (raw === undefined) return DEFAULT_EMBEDDING;
  const v = new Validator(ConfigError, source);
  const data = v.requireRecord(raw, "embedding");
  return Object.freeze({
    provider: v.get(data, "provider", STR, DEFAULT_EMBEDDING.provider),
    model: v.get(data, "model", STR, DEFAULT_EMBEDDING.model),
    normalize: v.get(data, "normalize", BOOL, DEFAULT_EMBEDDING.normalize),
  });
}

function watcherFrom(raw: unknown, source: string): WatcherConfig {
  if (raw === undefined) return DEFAULT_WATCHER;
  const v = new Validator(ConfigError, source);
  const data = v.requireRecord(raw, "watcher");
  return Object.freeze({
    debounceMs: v.get(data, "debounce_ms", INT_NON_NEG, DEFAULT_WATCHER.debounceMs),
  });
}
