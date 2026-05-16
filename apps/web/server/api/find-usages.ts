import { type Config, type Runtime, resolveUnderWorkspaceRoots } from "@loctx/core";
import type { Hono } from "hono";
import type { FindUsagesPayload, FindUsagesRequest, UsageHit } from "../../shared/contracts.js";

export function mountFindUsages(app: Hono, config: Config, getRuntime: () => Promise<Runtime>): void {
  app.post("/api/find-usages", async (c) => {
    const body = (await c.req.json().catch(() => null)) as FindUsagesRequest | null;
    const symbol = body?.symbol?.trim() ?? "";
    if (symbol === "") return c.json({ error: "symbol required" }, 400);

    const rt = await getRuntime();
    let projects = rt.discovery.discoverProjects();
    if (body?.path !== undefined && body.path !== "") {
      // Refuse paths outside configured workspace_roots so this surface
      // can't be used to probe arbitrary filesystem locations.
      const confined = resolveUnderWorkspaceRoots(body.path, config.workspaceRoots);
      if (confined === null) {
        return c.json({ error: "path is not under any configured workspace_root" }, 403);
      }
      const scoped = rt.discovery.resolveProject(confined);
      if (scoped === null) {
        return c.json({ error: `path ${body.path} is not inside any indexed project` }, 404);
      }
      projects = [scoped];
    }

    const defs: UsageHit[] = [];
    const refs: UsageHit[] = [];
    for (const project of projects) {
      const r = rt.state.findSymbol(project.id, symbol);
      for (const hit of r.defs) {
        defs.push(toHit(project.id, hit));
      }
      for (const hit of r.refs) {
        refs.push(toHit(project.id, hit));
      }
    }
    const payload: FindUsagesPayload = { symbol, defs, refs };
    return c.json(payload);
  });
}

function toHit(
  projectId: string,
  h: { relPath: string; chunkStartLine: number; chunkEndLine: number; kind: string },
): UsageHit {
  return {
    projectId,
    relPath: h.relPath,
    chunkStartLine: h.chunkStartLine,
    chunkEndLine: h.chunkEndLine,
    kind: h.kind,
  };
}
