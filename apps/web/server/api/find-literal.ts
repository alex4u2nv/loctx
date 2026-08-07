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
  FIND_LITERAL_COVERAGE_NOTE,
  parseFindLiteralToolInput,
  type ProjectId,
  type Runtime,
} from "@loctx/core";
import type { Hono } from "hono";
import type { FindLiteralPayload, LiteralHit } from "../../shared/contracts.js";
import { confinedPath } from "../lib/confined-path.js";
import { BadRequestError, jsonBody } from "../lib/http-errors.js";
import { reconcileWarnings } from "../lib/index-health-warnings.js";

export function mountFindLiteral(
  app: Hono,
  config: Config,
  getRuntime: () => Promise<Runtime>,
): void {
  app.post("/api/find-literal", async (c) => {
    const raw = await jsonBody(c);
    // Shared per-operation input spec (SRV-5) — same bounds + error
    // strings the MCP find_literal tool enforces.
    const { pattern, path } = parseFindLiteralToolInput(raw, BadRequestError);

    const rt = await getRuntime();
    const opts: { projectId?: ProjectId; relPathPrefix?: string } = {};
    if (path !== undefined) {
      // Same workspace-root guard the search endpoint uses — local
      // attackers on loopback shouldn't be able to probe arbitrary
      // filesystem locations via this surface (SRV-4).
      const confined = confinedPath(config, path);
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
      // Shared with the MCP transport so the wording can't drift (SRV-9).
      coverageNote: FIND_LITERAL_COVERAGE_NOTE,
      warnings: reconcileWarnings(rt),
    };
    return c.json(payload);
  });
}
