/**
 * On-disk index size, and its attribution to projects.
 *
 * The LanceDB store keeps every project's vectors in shared per-model
 * tables, so there is no per-project file to stat. What we can measure
 * exactly is the total (vector dir + SQLite state and its sidecars);
 * per-project figures are that total split in proportion to each
 * project's chunk count. Chunks are close to uniform in size, so the
 * split tracks reality well enough to answer "which project is most of
 * my index" — the question the /projects table asks. Shares sum to the
 * measured total by construction.
 *
 * Shared by /api/status (total only) and /api/projects (per row).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "@loctx/core";

/**
 * Recursively sum the byte size of a file or directory. Best-effort:
 * any path that can't be stat'd (vanished mid-walk, permission denied)
 * contributes 0 rather than throwing, so the dashboard always renders.
 */
export function pathSizeBytes(path: string): number {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  try {
    return readdirSync(path, { withFileTypes: true }).reduce(
      (total, entry) => total + pathSizeBytes(join(path, entry.name)),
      0,
    );
  } catch {
    return 0;
  }
}

/**
 * On-disk index size: the LanceDB vector store plus the SQLite state DB
 * and its WAL/SHM sidecars. `vectorDir` and `stateDb` are siblings under
 * `dataDir`, so summing them double-counts nothing.
 */
export function indexSizeBytes(config: Config): number {
  return [
    config.paths.vectorDir,
    config.paths.stateDb,
    `${config.paths.stateDb}-wal`,
    `${config.paths.stateDb}-shm`,
  ].reduce((total, path) => total + pathSizeBytes(path), 0);
}

/**
 * Split `totalBytes` across projects in proportion to their chunk
 * counts. Pure. A project with no chunks gets 0; with no chunks anywhere
 * every project gets 0 (the on-disk bytes are then schema/overhead that
 * belongs to nobody).
 */
export function attributeIndexBytes(
  totalBytes: number,
  chunkCounts: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const totalChunks = [...chunkCounts.values()].reduce((sum, n) => sum + n, 0);
  if (totalChunks <= 0 || totalBytes <= 0) {
    return new Map([...chunkCounts.keys()].map((id) => [id, 0]));
  }
  return new Map(
    [...chunkCounts].map(([id, chunks]) => [id, Math.round((totalBytes * chunks) / totalChunks)]),
  );
}
