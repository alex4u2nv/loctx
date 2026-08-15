/**
 * Project quality report (#525): read-only aggregation over stored
 * quality findings + the query-time cross-file rules. Provisioning
 * stays on the Analyzers tab; this endpoint only reads.
 */

import { type ProjectId, type Runtime, runQualityReport } from "@loctx/core";
import type { Hono } from "hono";
import type { QualityReportPayload } from "../../shared/contracts.js";

export function mountQuality(app: Hono, getRuntime: () => Promise<Runtime>): void {
  app.get("/api/projects/:id/quality", async (c) => {
    const id = c.req.param("id") as ProjectId;
    const limitRaw = Number(c.req.query("limit") ?? "20");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), 100) : 20;
    const rule = c.req.query("rule");

    const rt = await getRuntime();
    const project = rt.state.listProjects().find((p) => p.id === id && p.active);
    if (project === undefined) {
      return c.json({ error: "project not found or not yet activated" }, 404);
    }

    const an = rt.config.analyzers;
    const disabled =
      !an.backgroundEnabled || !an.quality.enabled
        ? "quality analyzer is off — stored per-file rules are missing; cross-file rules still ran."
        : null;
    const report = await runQualityReport(
      rt,
      { id: project.id, name: project.name, root: project.root },
      { limit, ...(rule !== undefined && rule !== "" ? { rule } : {}) },
    );
    const payload: QualityReportPayload = {
      files: report.files,
      totals: report.totals,
      notes: report.notes,
      disabled,
    };
    return c.json(payload);
  });
}
