import { type Config, WorkspaceDiscovery, readActiveDaemon } from "@loctx/core";
import type { Hono } from "hono";
import type { StatusPayload } from "../../shared/contracts.js";

export function mountStatus(app: Hono, config: Config): void {
  app.get("/api/status", (c) => {
    const discovery = new WorkspaceDiscovery(config.workspaceRoots);
    const projects = discovery.discoverProjects();
    const daemon = readActiveDaemon(config.paths.dataDir);
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
        retrievalMode: config.retrieval.mode,
        watcherDebounceMs: config.watcher.debounceMs,
        reconciliationIntervalSeconds: config.reconciliation.intervalSeconds,
        reconciliationRunOnStart: config.reconciliation.runOnStart,
      },
      projects: projects.map((p) => ({ id: p.id, name: p.name, root: p.root })),
    };
    return c.json(payload);
  });
}
