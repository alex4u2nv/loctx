import { type Config, type Runtime, resolveUnderWorkspaceRoots } from "@loctx/core";
import type { Hono } from "hono";
import type { FindUsagesPayload, UsageHit } from "../../shared/contracts.js";
import { parseString } from "../lib/request-validation.js";

export function mountFindUsages(app: Hono, config: Config, getRuntime: () => Promise<Runtime>): void {
  app.post("/api/find-usages", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (raw === null) {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const symbol = parseString(raw["symbol"], { maxLength: 256 });
    if (symbol === null || symbol === "") {
      return c.json({ error: "symbol required (non-empty string, ≤ 256 chars)" }, 400);
    }
    const pathField = parseString(raw["path"], { maxLength: 1024 });
    if (pathField === null && raw["path"] !== undefined) {
      return c.json({ error: "path must be a string (≤ 1024 chars)" }, 400);
    }

    const rt = await getRuntime();
    let projects = rt.discovery.discoverProjects();
    if (pathField !== null && pathField !== "") {
      // Refuse paths outside configured workspace_roots so this surface
      // can't be used to probe arbitrary filesystem locations.
      const confined = resolveUnderWorkspaceRoots(pathField, config.workspaceRoots);
      if (confined === null) {
        return c.json({ error: "path is not under any configured workspace_root" }, 403);
      }
      const scoped = rt.discovery.resolveProject(confined);
      if (scoped === null) {
        return c.json({ error: `path is not inside any indexed project` }, 404);
      }
      projects = [scoped];
    }

    const defs: UsageHit[] = [];
    const refs: UsageHit[] = [];
    for (const project of projects) {
      const r = rt.state.findSymbol(project.id, symbol);
      for (const hit of r.defs) {
        defs.push(toHit(project.id, project.name, hit));
      }
      for (const hit of r.refs) {
        refs.push(toHit(project.id, project.name, hit));
      }
    }
    const payload: FindUsagesPayload = { symbol, defs, refs };
    return c.json(payload);
  });
}

function toHit(
  projectId: string,
  projectName: string,
  h: { relPath: string; chunkStartLine: number; chunkEndLine: number; kind: string },
): UsageHit {
  return {
    projectId,
    projectName,
    relPath: h.relPath,
    chunkStartLine: h.chunkStartLine,
    chunkEndLine: h.chunkEndLine,
    kind: h.kind,
  };
}
