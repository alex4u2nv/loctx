import { type Config, type Runtime, resolveUnderWorkspaceRoots } from "@loctx/core";
import type { Hono } from "hono";
import type { SearchPayload, SearchRequestBody } from "../../shared/contracts.js";

export function mountSearch(app: Hono, config: Config, getRuntime: () => Promise<Runtime>): void {
  app.post("/api/search", async (c) => {
    const body = (await c.req.json().catch(() => null)) as SearchRequestBody | null;
    if (body === null || typeof body.query !== "string" || body.query.trim() === "") {
      return c.json({ error: "query required" }, 400);
    }
    // Bound an optional path filter to configured workspace_roots so a
    // caller can't probe arbitrary filesystem locations via the search
    // surface.
    let scopedPath: string | undefined;
    if (body.path !== undefined && body.path !== "") {
      const confined = resolveUnderWorkspaceRoots(body.path, config.workspaceRoots);
      if (confined === null) {
        return c.json({ error: "path is not under any configured workspace_root" }, 403);
      }
      scopedPath = confined;
    }
    try {
      const rt = await getRuntime();
      const response = await rt.searcher.search({
        query: body.query.trim(),
        ...(scopedPath !== undefined ? { path: scopedPath } : {}),
        ...(body.language !== undefined && body.language !== ""
          ? { language: body.language }
          : {}),
        ...(body.coverage === true ? { coverage: true } : {}),
        limit: typeof body.limit === "number" ? body.limit : 10,
      });
      const payload: SearchPayload = {
        resolvedScope: {
          mode: response.resolvedScope.mode,
          project:
            response.resolvedScope.project !== null
              ? {
                  id: response.resolvedScope.project.id,
                  name: response.resolvedScope.project.name,
                }
              : null,
          relPrefix: response.resolvedScope.relPrefix,
        },
        results: response.results.map((r) => ({
          projectId: r.projectId,
          projectName: r.projectName,
          relPath: r.relPath,
          absPath: r.absPath,
          startLine: r.startLine,
          endLine: r.endLine,
          score: r.score,
          snippet: r.snippet,
          language: r.language,
          kind: r.kind,
          symbols: [...r.symbols],
          sources: [...r.sources],
          matchReasons: [...r.matchReasons],
          coverageReason: r.coverageReason,
          enrichments: {
            lizard:
              r.enrichments.lizard !== null
                ? {
                    functionName: r.enrichments.lizard.functionName,
                    ccn: r.enrichments.lizard.ccn,
                    nloc: r.enrichments.lizard.nloc,
                    tokens: r.enrichments.lizard.tokens,
                    parameters: r.enrichments.lizard.parameters,
                  }
                : null,
            findings: r.enrichments.findings.map((f) => ({
              analyzer: f.analyzer,
              ruleId: f.ruleId,
              severity: f.severity,
              message: f.message,
              category: f.category,
              lineFrom: f.lineFrom,
              lineTo: f.lineTo,
            })),
          },
        })),
        warnings: [...response.warnings],
      };
      return c.json(payload);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
}
