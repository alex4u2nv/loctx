import {
  type Config,
  estimateQueryValue,
  parseSearchToolInput,
  type ProjectId,
  type Runtime,
  toUsageDeltas,
} from "@loctx/core";
import type { Hono } from "hono";
import type { SearchHit, SearchPayload } from "../../shared/contracts.js";
import { confinedPath } from "../lib/confined-path.js";
import { BadRequestError, jsonBody } from "../lib/http-errors.js";
import { reconcileWarnings } from "../lib/index-health-warnings.js";
import { sanitizeError } from "../lib/request-validation.js";

export function mountSearch(app: Hono, config: Config, getRuntime: () => Promise<Runtime>): void {
  app.post("/api/search", async (c) => {
    const raw = await jsonBody(c);
    // Shared per-operation input spec (SRV-5) — same bounds + error
    // strings the MCP search_workspace tool enforces.
    const input = parseSearchToolInput(raw, BadRequestError);

    // Bound an optional path filter to configured workspace_roots so a
    // caller can't probe arbitrary filesystem locations via the search
    // surface.
    const scopedPath = input.path !== undefined ? confinedPath(config, input.path) : undefined;
    try {
      const rt = await getRuntime();
      const startedAt = Date.now();
      const response = await rt.searcher.search({
        query: input.query,
        ...(scopedPath !== undefined ? { path: scopedPath } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
        ...(input.coverage ? { coverage: true } : {}),
        limit: input.limit,
      });
      const reconcile = rt.reconciler.status();
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
        // SearchHit is derived from the core result type, so the map is
        // a spread minus the fields the wire drops (SRV-10).
        results: response.results.map((r): SearchHit => {
          const { projectRoot: _projectRoot, analyzer: _analyzer, ...hit } = r;
          return {
            ...hit,
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
              findings: r.enrichments.findings,
            },
          };
        }),
        warnings: [...reconcileWarnings(rt), ...response.warnings],
        // Mirrors the MCP tools' liveness signal (#43). We ARE the
        // daemon, so reconciling is authoritative — never "unknown".
        indexHealth: {
          reconciling: reconcile.running,
          startedAt: reconcile.startedAt,
          currentProject: reconcile.currentProjectName,
          completed: reconcile.completed,
          total: reconcile.total,
          currentProjectIndexed: reconcile.currentProjectIndexed,
          currentProjectTotal: reconcile.currentProjectTotal,
        },
      };
      // Admin-UI searches count toward tokens-saved like MCP searches
      // do (#value-metrics, SRV-10). The payload carries the same
      // projectId/relPath/snippet fields the estimator reads.
      recordSearchUsageValue(rt, payload, Date.now() - startedAt);
      return c.json(payload);
    } catch (err) {
      return c.json(sanitizeError("search", err, "see daemon logs for details"), 500);
    }
  });
}

/**
 * Estimate + persist the "value served" of one HTTP search — same
 * fire-and-forget accounting the MCP transport does in its registry.
 * Deferred to the next tick so it never adds latency, and fully
 * swallowed: a value metric must never break a search response.
 */
function recordSearchUsageValue(rt: Runtime, payload: SearchPayload, elapsedMs: number): void {
  setImmediate(() => {
    try {
      const value = estimateQueryValue("search_workspace", payload, (projectId, relPath) => {
        const file = rt.state.getFile(projectId as ProjectId, relPath);
        return file?.size ?? null;
      });
      rt.state.applyUsageDeltas(toUsageDeltas(value, elapsedMs));
    } catch {
      // Accounting is observability, not correctness.
    }
  });
}
