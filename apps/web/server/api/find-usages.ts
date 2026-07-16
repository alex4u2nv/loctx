import {
  type Config,
  findSymbolUsages,
  type Runtime,
  resolveUnderWorkspaceRoots,
} from "@loctx/core";
import type { Hono } from "hono";
import type { FindUsagesPayload, UsageHit } from "../../shared/contracts.js";
import { reconcileWarnings } from "../lib/index-health-warnings.js";
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
    let scopePath: string | undefined;
    if (pathField !== null && pathField !== "") {
      // Refuse paths outside configured workspace_roots so this surface
      // can't be used to probe arbitrary filesystem locations.
      const confined = resolveUnderWorkspaceRoots(pathField, config.workspaceRoots);
      if (confined === null) {
        return c.json({ error: "path is not under any configured workspace_root" }, 403);
      }
      scopePath = confined;
    }

    // Shared resolve-scope → findSymbol sweep (#449). Previously this
    // endpoint used plain discovery.resolveProject, so a path inside an
    // unindexed inner package (#276) resolved to the empty inner project
    // and silently returned zero hits — while the same path through the
    // MCP tool scoped to the indexed parent and found them.
    const result = findSymbolUsages(rt.discovery, rt.state, symbol, scopePath);
    if (result.kind === "outside-indexed") {
      return c.json({ error: "path is not inside any indexed project" }, 404);
    }

    const defs: UsageHit[] = [];
    const refs: UsageHit[] = [];
    for (const { project, defs: pDefs, refs: pRefs } of result.projects) {
      for (const hit of pDefs) {
        defs.push(toHit(project.id, project.name, hit));
      }
      for (const hit of pRefs) {
        refs.push(toHit(project.id, project.name, hit));
      }
    }
    const payload: FindUsagesPayload = {
      symbol,
      defs,
      refs,
      warnings: [...result.warnings, ...reconcileWarnings(rt)],
    };
    return c.json(payload);
  });
}

function toHit(
  projectId: string,
  projectName: string,
  h: {
    relPath: string;
    chunkStartLine: number;
    chunkEndLine: number;
    kind: string;
    document: string;
  },
): UsageHit {
  return {
    projectId,
    projectName,
    relPath: h.relPath,
    chunkStartLine: h.chunkStartLine,
    chunkEndLine: h.chunkEndLine,
    kind: h.kind,
    snippet: h.document,
  };
}
