import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  type Runtime,
  WorkspaceDiscovery,
  readActiveDaemon,
  summarizeUsage,
} from "@loctx/core";
import type { Hono } from "hono";
import type { StatusPayload, ValueMetrics } from "../../shared/contracts.js";

const ZERO_VALUE: ValueMetrics = {
  queries: 0,
  tokensSaved: 0,
  baselineTokens: 0,
  reductionPct: 0,
  filesReadAvoided: 0,
  zeroHitQueries: 0,
  zeroHitPct: 0,
  avgLatencyMs: 0,
};

/**
 * Recursively sum the byte size of a file or directory. Best-effort:
 * any path that can't be stat'd (vanished mid-walk, permission denied)
 * contributes 0 rather than throwing, so the dashboard always renders.
 */
function pathSizeBytes(path: string): number {
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
function indexSizeBytes(config: Config): number {
  return [
    config.paths.vectorDir,
    config.paths.stateDb,
    `${config.paths.stateDb}-wal`,
    `${config.paths.stateDb}-shm`,
  ].reduce((total, path) => total + pathSizeBytes(path), 0);
}

export function mountStatus(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
): void {
  // One discovery instance for the server's lifetime instead of one per
  // request (#455) — /api/status is polled every 3-8s by the admin UI.
  const discovery = new WorkspaceDiscovery(config.workspaceRoots);

  app.get("/api/status", async (c) => {
    const projects = discovery.discoverProjects();
    const daemon = readActiveDaemon(config.paths.dataDir);
    // Best-effort runtime lookup — if the runtime hasn't built yet
    // (very early in boot, model still downloading), expose what we can
    // from config and mark the embedding as not-ready. Status itself
    // must keep working so the admin UI can render.
    let embeddingReady = false;
    let reconciliation = {
      running: false,
      startedAt: null as string | null,
      currentProjectName: null as string | null,
      completed: 0,
      total: 0,
      currentProjectIndexed: null as number | null,
      currentProjectTotal: null as number | null,
    };
    let analyzers = {
      depth: 0,
      running: 0,
      completed: 0,
      failures: 0,
      lastRunAt: null as string | null,
    };
    let maintenance = {
      running: false,
      startedAt: null as string | null,
      lastRunAt: null as string | null,
      lastFreedBytes: null as number | null,
    };
    let value: ValueMetrics = ZERO_VALUE;
    try {
      const rt = await getRuntime();
      embeddingReady = true;
      reconciliation = rt.reconciler.status();
      analyzers = rt.enrichments.status();
      maintenance = rt.maintenanceStatus();
      value = summarizeUsage(rt.state.readUsageStats()).workspace;
    } catch {
      // Leave defaults; daemon is still booting or build failed.
    }
    const payload: StatusPayload = {
      daemon:
        daemon !== null
          ? {
              running: true,
              pid: daemon.pid,
              hostname: daemon.hostname ?? null,
              port: daemon.port ?? null,
              startedAt: daemon.startedAt,
              version: daemon.version,
            }
          : { running: false, pidLockPath: `${config.paths.dataDir}/loctx.pid` },
      runtime: {
        configGlobal: config.source,
        dataDir: config.paths.dataDir,
        vectorDir: config.paths.vectorDir,
        stateDb: config.paths.stateDb,
        indexSizeBytes: indexSizeBytes(config),
        embeddingProvider: config.embedding.provider,
        embeddingModel: config.embedding.model,
        embeddingReady,
        retrievalMode: config.retrieval.mode,
        watcherDebounceMs: config.watcher.debounceMs,
        reconciliationIntervalSeconds: config.reconciliation.intervalSeconds,
        reconciliationRunOnStart: config.reconciliation.runOnStart,
        compactIntervalHours: config.maintenance.compactIntervalHours,
      },
      reconciliation,
      analyzers,
      maintenance,
      projects: projects.map((p) => ({ id: p.id, name: p.name, root: p.root })),
      value,
    };
    return c.json(payload);
  });
}
