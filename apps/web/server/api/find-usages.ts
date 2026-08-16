import { type Config, findSymbolUsages, parseFindUsagesToolInput, type Runtime } from "@loctx/core";
import type { Hono } from "hono";
import type { FindUsagesPayload, UsageHit } from "../../shared/contracts.js";
import { confinedPath } from "../lib/confined-path.js";
import { BadRequestError, jsonBody } from "../lib/http-errors.js";
import { reconcileWarnings } from "../lib/index-health-warnings.js";

export function mountFindUsages(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
): void {
  app.post("/api/find-usages", async (c) => {
    const raw = await jsonBody(c);
    // Shared per-operation input spec (SRV-5) — same bounds + error
    // strings the MCP find_usages tool enforces.
    const { symbol, path } = parseFindUsagesToolInput(raw, BadRequestError);

    const rt = await getRuntime();
    // Refuse paths outside configured workspace_roots so this surface
    // can't be used to probe arbitrary filesystem locations (SRV-4).
    const scopePath = path !== undefined ? confinedPath(config, path) : undefined;

    // Shared resolve-scope → findSymbol sweep (#449). Previously this
    // endpoint used plain discovery.resolveProject, so a path inside an
    // unindexed inner package (#276) resolved to the empty inner project
    // and silently returned zero hits — while the same path through the
    // MCP tool scoped to the indexed parent and found them.
    const result = findSymbolUsages(rt.discovery, rt.state, symbol, scopePath);
    if (result.kind === "outside-indexed") {
      return c.json(
        { error: "path is not inside any indexed project; omit path to search every project" },
        404,
      );
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
