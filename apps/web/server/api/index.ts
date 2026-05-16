/**
 * API mount point. Every endpoint is JSON-in / JSON-out except SSE on
 * /api/events and the long-running ops endpoints (/api/index,
 * /api/models/download) which stream NDJSON-style OpEvent lines.
 */

import type { Config, Runtime, WatcherRegistry } from "@loctx/core";
import type { Hono } from "hono";
import { createRebuildTracker } from "../lib/rebuild-tracker.js";
import { mountConfig } from "./config.js";
import { mountDoctor } from "./doctor.js";
import { mountEvents } from "./events.js";
import { mountFindUsages } from "./find-usages.js";
import { mountModels } from "./models.js";
import { mountOps } from "./ops.js";
import { mountProjects } from "./projects.js";
import { mountSearch } from "./search.js";
import { mountStatus } from "./status.js";
import { mountWatchers } from "./watchers.js";

export function mountApi(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
  watcherRegistry?: WatcherRegistry,
): void {
  // Shared between /api/rebuild (writes) and /api/projects (reads). One
  // tracker per daemon process so all UIs hitting the same daemon see
  // the same rebuild progress.
  const rebuildTracker = createRebuildTracker();
  mountStatus(app, config, getRuntime);
  mountProjects(app, config, watcherRegistry, getRuntime, rebuildTracker);
  mountSearch(app, config, getRuntime);
  mountEvents(app);
  mountDoctor(app, config, watcherRegistry);
  mountConfig(app, config);
  mountModels(app, config);
  mountFindUsages(app, config, getRuntime);
  mountOps(app, config, getRuntime, rebuildTracker);
  mountWatchers(app, watcherRegistry);
}
