/**
 * Literal-substring audit endpoint (#357). Companion to `/api/search`
 * (ranked) and `/api/find-usages` (exact symbol). This is the
 * exhaustiveness tool — every chunk-text line containing the
 * substring, with file:line:column + surrounding context.
 *
 * Coverage caveat (mirrored on the MCP side): scans indexed chunk
 * text, so chunker gaps (#360) are blind spots. The response always
 * carries `coverageNote` so the caller knows when to supplement with
 * `rg`.
 */

import {
  type Config,
  type ProjectId,
  type Runtime,
  resolveUnderWorkspaceRoots,
} from "@loctx/core";
import type { Hono } from "hono";
import type { FindLiteralPayload, LiteralHit } from "../../shared/contracts.js";
import { reconcileWarnings } from "../lib/index-health-warnings.js";
import { parseString } from "../lib/request-validation.js";

const COVERAGE_NOTE =
  "Scans indexed chunk text only. Blind spots: (1) chunker-gap regions inside indexed files (#360 — gap-fill in #362/#364 doesn't cover 100% of lines); (2) files under directories the filtering rules exclude — typically `.git/`, `node_modules/`, build outputs (`dist/`, `build/`, `coverage/`), and lockfiles by basename. Inspect the exact list via `workspace_status` → `exclusions`. For safety-critical audits, cross-check with `rg <pattern>`.";

export function mountFindLiteral(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
): void {
  app.post("/api/find-literal", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (raw === null) {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const pattern = parseString(raw["pattern"], { maxLength: 1024 });
    if (pattern === null || pattern === "") {
      return c.json({ error: "pattern required (non-empty string, ≤ 1024 chars)" }, 400);
    }
    const pathField = parseString(raw["path"], { maxLength: 1024 });
    if (pathField === null && raw["path"] !== undefined) {
      return c.json({ error: "path must be a string (≤ 1024 chars)" }, 400);
    }

    const rt = await getRuntime();
    const opts: { projectId?: ProjectId; relPathPrefix?: string } = {};
    if (pathField !== null && pathField !== "") {
      // Same workspace-root guard the search endpoint uses — local
      // attackers on loopback shouldn't be able to probe arbitrary
      // filesystem locations via this surface.
      const confined = resolveUnderWorkspaceRoots(pathField, config.workspaceRoots);
      if (confined === null) {
        return c.json({ error: "path is not under any configured workspace_root" }, 403);
      }
      const scoped = rt.discovery.resolveProject(confined);
      if (scoped === null) {
        return c.json({ error: "path is not inside any indexed project" }, 404);
      }
      opts.projectId = scoped.id;
      if (confined.startsWith(`${scoped.root}/`)) {
        opts.relPathPrefix = confined.slice(scoped.root.length + 1);
      }
    }

    const matches = rt.state.findLiteralMatches(pattern, opts).map(
      (m): LiteralHit => ({
        projectId: m.projectId,
        projectName: m.projectName,
        relPath: m.relPath,
        chunkKind: m.chunkKind,
        chunkStartLine: m.chunkStartLine,
        chunkEndLine: m.chunkEndLine,
        line: m.line,
        column: m.column,
        lineText: m.lineText,
      }),
    );
    const fileCount = new Set(matches.map((m) => `${m.projectId}:${m.relPath}`)).size;
    const payload: FindLiteralPayload = {
      pattern,
      matches,
      fileCount,
      coverageNote: COVERAGE_NOTE,
      warnings: reconcileWarnings(rt),
    };
    return c.json(payload);
  });
}
