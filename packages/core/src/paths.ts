/**
 * XDG path resolution for loctx storage and configuration.
 *
 * Defaults to `env-paths`'s platform conventions (e.g.
 * `~/Library/Application Support/loctx` on macOS, XDG dirs on Linux).
 * Two env vars override the defaults — primarily for tests that need
 * isolated storage:
 *
 *   - `LOCTX_DATA_DIR` overrides the data dir (chroma, state.sqlite3, logs).
 *   - `LOCTX_CONFIG_DIR` overrides the config dir (config.yaml).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import envPaths from "env-paths";

const PATHS = envPaths("loctx", { suffix: "" });

export interface StoragePaths {
  readonly dataDir: string;
  readonly configDir: string;
  readonly chromaDir: string;
  readonly stateDb: string;
  readonly logsDir: string;
}

function envOverride(key: string): string | undefined {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

export function defaultPaths(): StoragePaths {
  const dataDir = envOverride("LOCTX_DATA_DIR") ?? PATHS.data;
  const configDir = envOverride("LOCTX_CONFIG_DIR") ?? PATHS.config;
  return {
    dataDir,
    configDir,
    chromaDir: join(dataDir, "chroma"),
    stateDb: join(dataDir, "state.sqlite3"),
    logsDir: join(dataDir, "logs"),
  };
}

/** Create all storage directories if missing. Idempotent. */
export function ensurePaths(paths: StoragePaths): void {
  for (const dir of [paths.dataDir, paths.configDir, paths.chromaDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function defaultConfigFile(): string {
  return join(envOverride("LOCTX_CONFIG_DIR") ?? PATHS.config, "config.yaml");
}
