/**
 * Code Health (#health).
 *
 *   GET  /api/projects/:id/health            read the latest snapshot + history
 *   POST /api/projects/:id/health/recompute  score now, persist, return it
 *
 * The GET never computes: scoring runs a full-project quality report and
 * writes, which is a POST's job (the CSRF guard covers POST, and a GET
 * with side effects would be a cheap DoS). Concurrent recomputes for the
 * same project share one run.
 */

import {
  decodeHealthSnapshot,
  type HealthScoreResult,
  type Project,
  type ProjectId,
  type Runtime,
  scoreProjectHealth,
} from "@loctx/core";
import type { Hono } from "hono";
import type { CodeHealthPayload } from "../../shared/contracts.js";

export interface MountHealthOptions {
  /** Injected for tests; defaults to the real scorer. */
  readonly score?: (runtime: Runtime, project: Project) => Promise<HealthScoreResult | null>;
}

const HISTORY_LIMIT = 30;

export function mountHealth(
  app: Hono,
  getRuntime: () => Promise<Runtime>,
  options: MountHealthOptions = {},
): void {
  const score = options.score ?? scoreProjectHealth;
  const inFlight = new Map<string, Promise<HealthScoreResult | null>>();

  const activeProject = (rt: Runtime, id: string): Project | null => {
    const found = rt.state.listProjects().find((p) => p.id === id && p.active);
    return found === undefined ? null : { id: found.id, name: found.name, root: found.root };
  };

  const payloadFor = (rt: Runtime, project: Project): CodeHealthPayload => {
    const latest = rt.state.listProjectHealth(project.id, 1)[0];
    const health = latest === undefined ? null : decodeHealthSnapshot(latest);
    return {
      projectId: project.id,
      projectName: project.name,
      snapshot:
        latest !== undefined && health !== null ? { computedAt: latest.computedAt, health } : null,
      history: rt.state.listProjectHealth(project.id, HISTORY_LIMIT).map((h) => ({
        computedAt: h.computedAt,
        score: h.score,
        grade: h.grade,
      })),
    };
  };

  app.get("/api/projects/:id/health", async (c) => {
    const rt = await getRuntime();
    const project = activeProject(rt, c.req.param("id") as ProjectId);
    if (project === null) {
      return c.json({ error: "project not found or not yet activated" }, 404);
    }
    return c.json(payloadFor(rt, project));
  });

  app.post("/api/projects/:id/health/recompute", async (c) => {
    const rt = await getRuntime();
    const project = activeProject(rt, c.req.param("id") as ProjectId);
    if (project === null) {
      return c.json({ error: "project not found or not yet activated" }, 404);
    }
    const running =
      inFlight.get(project.id) ??
      score(rt, project).finally(() => {
        inFlight.delete(project.id);
      });
    inFlight.set(project.id, running);
    const result = await running;
    if (result === null) {
      return c.json({ error: "nothing indexed yet — index the project first" }, 409);
    }
    return c.json(payloadFor(rt, project));
  });
}
