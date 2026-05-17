import { type Config, type Runtime, WorkspaceDiscovery, readActiveDaemon } from "@loctx/core";
import type { Hono } from "hono";
import type { StatusPayload } from "../../shared/contracts.js";

export function mountStatus(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
): void {
  app.get("/api/status", async (c) => {
    const discovery = new WorkspaceDiscovery(config.workspaceRoots);
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
    try {
      const rt = await getRuntime();
      embeddingReady = true;
      reconciliation = rt.reconciler.status();
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
        embeddingProvider: config.embedding.provider,
        embeddingModel: config.embedding.model,
        embeddingReady,
        retrievalMode: config.retrieval.mode,
        watcherDebounceMs: config.watcher.debounceMs,
        reconciliationIntervalSeconds: config.reconciliation.intervalSeconds,
        reconciliationRunOnStart: config.reconciliation.runOnStart,
      },
      reconciliation,
      projects: projects.map((p) => ({ id: p.id, name: p.name, root: p.root })),
    };
    return c.json(payload);
  });
}
