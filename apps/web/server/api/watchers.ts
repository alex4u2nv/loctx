/**
 * Watcher state + control endpoints.
 *
 *   GET  /api/watchers              → list of every project being watched
 *   POST /api/watch/pause           → body { projectId } → 200 { paused }
 *   POST /api/watch/resume          → body { projectId } → 200 { resumed }
 *
 * `projectId` is required. Pausing or resuming "all" should be done by
 * iterating client-side; the per-project shape keeps the contract
 * stateless and obvious.
 */

import type { ProjectId, WatcherRegistry } from "@loctx/core";
import type { Hono } from "hono";
import type { WatchersPayload } from "../../shared/contracts.js";
import { jsonBody } from "../lib/http-errors.js";

export function mountWatchers(app: Hono, registry: WatcherRegistry | undefined): void {
  app.get("/api/watchers", (c) => {
    const payload: WatchersPayload = {
      enabled: registry !== undefined,
      entries:
        registry === undefined
          ? []
          : registry.list().map((e) => ({
              projectId: e.projectId,
              projectName: e.projectName,
              projectRoot: e.projectRoot,
              state: e.state,
              startedAt: e.startedAt,
              failureReason: e.failureReason,
            })),
    };
    return c.json(payload);
  });

  app.post("/api/watch/pause", async (c) => {
    if (registry === undefined) {
      return c.json({ error: "watcher disabled (daemon started with --no-watch)" }, 409);
    }
    const body = await jsonBody(c);
    const projectId = typeof body["projectId"] === "string" ? body["projectId"].trim() : "";
    if (projectId === "") return c.json({ error: "projectId required" }, 400);
    const entry = registry.pause(projectId as ProjectId);
    if (entry === null) return c.json({ error: `unknown projectId ${projectId}` }, 404);
    return c.json({ ok: true, paused: projectId, state: entry.state });
  });

  app.post("/api/watch/resume", async (c) => {
    if (registry === undefined) {
      return c.json({ error: "watcher disabled (daemon started with --no-watch)" }, 409);
    }
    const body = await jsonBody(c);
    const projectId = typeof body["projectId"] === "string" ? body["projectId"].trim() : "";
    if (projectId === "") return c.json({ error: "projectId required" }, 400);
    const entry = registry.resume(projectId as ProjectId);
    if (entry === null) return c.json({ error: `unknown projectId ${projectId}` }, 404);
    return c.json({ ok: true, resumed: projectId, state: entry.state });
  });
}
