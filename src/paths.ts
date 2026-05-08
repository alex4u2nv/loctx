/**
 * XDG path resolution for loctx storage and configuration.
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

export function defaultPaths(): StoragePaths {
  return {
    dataDir: PATHS.data,
    configDir: PATHS.config,
    chromaDir: join(PATHS.data, "chroma"),
    stateDb: join(PATHS.data, "state.sqlite3"),
    logsDir: join(PATHS.data, "logs"),
  };
}

/** Create all storage directories if missing. Idempotent. */
export function ensurePaths(paths: StoragePaths): void {
  for (const dir of [paths.dataDir, paths.configDir, paths.chromaDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function defaultConfigFile(): string {
  return join(PATHS.config, "config.toml");
}
