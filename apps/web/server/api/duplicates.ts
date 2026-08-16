/**
 * Duplicates inspector (#523 surfacing): exact token-window groups +
 * embedding-based semantic groups for one project, with relPaths
 * joined so the UI can render file names. Read-only; the semantic
 * pass runs through the same core runner as the MCP tool, so gating,
 * caps, and truncation semantics are identical across surfaces.
 */

import { type ProjectId, type Runtime, runSemanticDuplicates } from "@loctx/core";
import type { Hono } from "hono";
import type { DuplicatesPayload } from "../../shared/contracts.js";

export function mountDuplicates(app: Hono, getRuntime: () => Promise<Runtime>): void {
  app.get("/api/find-duplicates", async (c) => {
    const id = c.req.query("project") ?? "";
    const minRaw = Number(c.req.query("min_members") ?? "2");
    const minMembers = Number.isFinite(minRaw) ? Math.min(Math.max(2, minRaw), 50) : 2;

    const rt = await getRuntime();
    const project = rt.state.listProjects().find((p) => p.id === (id as ProjectId) && p.active);
    if (project === undefined) {
      return c.json({ error: "project not found or not yet activated" }, 404);
    }

    const an = rt.config.analyzers;
    let disabled: string | null = null;
    if (!an.backgroundEnabled) {
      disabled =
        "analyzers.backgroundEnabled is false in config — enable it and restart the daemon.";
    } else if (!an.duplicates.enabled) {
      disabled =
        "analyzers.duplicates.enabled is false in config — enable it and restart the daemon.";
    }

    const relPathById = new Map(
      rt.state.listFiles(project.id).map((f) => [f.fileId as string, f.relPath]),
    );
    const groups = rt.state.findDuplicateGroups(minMembers, project.id).map((g) => ({
      hash: g.hash,
      members: g.members.map((m) => ({
        fileId: m.fileId as string,
        relPath: relPathById.get(m.fileId as string) ?? "(no longer indexed)",
        startLine: m.startLine,
        endLine: m.endLine,
      })),
    }));

    const { semantic, semanticDisabled, warning } = await runSemanticDuplicates(
      rt,
      project.id,
      minMembers,
    );

    const payload: DuplicatesPayload = {
      projectId: project.id as string,
      projectName: project.name,
      groups,
      semantic,
      semanticDisabled,
      disabled,
      warnings: warning !== null ? [warning] : [],
    };
    return c.json(payload);
  });
}
