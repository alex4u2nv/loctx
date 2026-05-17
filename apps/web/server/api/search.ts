import { type Config, type Runtime, resolveUnderWorkspaceRoots } from "@loctx/core";
import type { Hono } from "hono";
import type { SearchPayload } from "../../shared/contracts.js";
import { reconcileWarnings } from "../lib/index-health-warnings.js";
import {
  parseBool,
  parseInt as parseBoundedInt,
  parseString,
  sanitizeError,
} from "../lib/request-validation.js";

export function mountSearch(app: Hono, config: Config, getRuntime: () => Promise<Runtime>): void {
  app.post("/api/search", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (raw === null) {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const query = parseString(raw["query"], { maxLength: 2048 });
    if (query === null || query === "") {
      return c.json({ error: "query required (non-empty string, ≤ 2048 chars)" }, 400);
    }
    const limit = parseBoundedInt(raw["limit"], { min: 1, max: 1000, default: 10 });
    if (limit === null) {
      return c.json({ error: "limit must be an integer in [1, 1000]" }, 400);
    }
    const language = parseString(raw["language"], { maxLength: 32 });
    if (language === null && raw["language"] !== undefined) {
      return c.json({ error: "language must be a string (≤ 32 chars)" }, 400);
    }
    const coverage = parseBool(raw["coverage"]);
    if (coverage === null) {
      return c.json({ error: "coverage must be a boolean" }, 400);
    }
    const pathField = parseString(raw["path"], { maxLength: 1024 });
    if (pathField === null && raw["path"] !== undefined) {
      return c.json({ error: "path must be a string (≤ 1024 chars)" }, 400);
    }

    // Bound an optional path filter to configured workspace_roots so a
    // caller can't probe arbitrary filesystem locations via the search
    // surface.
    let scopedPath: string | undefined;
    if (pathField !== null && pathField !== "") {
      const confined = resolveUnderWorkspaceRoots(pathField, config.workspaceRoots);
      if (confined === null) {
        return c.json({ error: "path is not under any configured workspace_root" }, 403);
      }
      scopedPath = confined;
    }
    try {
      const rt = await getRuntime();
      const response = await rt.searcher.search({
        query,
        ...(scopedPath !== undefined ? { path: scopedPath } : {}),
        ...(language !== null && language !== "" ? { language } : {}),
        ...(coverage === true ? { coverage: true } : {}),
        limit,
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
        warnings: [...reconcileWarnings(rt), ...response.warnings],
      };
      return c.json(payload);
    } catch (err) {
      return c.json(sanitizeError("search", err, "see daemon logs for details"), 500);
    }
  });
}
