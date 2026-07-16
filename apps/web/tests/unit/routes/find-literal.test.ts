/**
 * POST /api/find-literal — pattern validation, workspace-root
 * confinement, 404 for an unindexed confined path, and match shaping.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountFindLiteral } from "../../../server/api/find-literal.js";
import { appWith, fakeConfig, fakeRuntime, postJson } from "../helpers/harness.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loctx-fl-"));
  mkdirSync(join(root, "alpha"), { recursive: true });
});

describe("POST /api/find-literal", () => {
  it("400s when pattern is missing or empty", async () => {
    const app = appWith(mountFindLiteral, fakeConfig(), fakeRuntime());
    expect((await postJson(app, "/api/find-literal", {})).status).toBe(400);
    expect((await postJson(app, "/api/find-literal", { pattern: "" })).status).toBe(400);
  });

  it("403s when path escapes the workspace roots", async () => {
    const app = appWith(mountFindLiteral, fakeConfig({ workspaceRoots: [root] }), fakeRuntime());
    const { status } = await postJson(app, "/api/find-literal", {
      pattern: "TODO",
      path: "/etc",
    });
    expect(status).toBe(403);
  });

  it("404s when a confined path is not inside any indexed project", async () => {
    const app = appWith(
      mountFindLiteral,
      fakeConfig({ workspaceRoots: [root] }),
      fakeRuntime({ discovery: { resolveProject: () => null } }),
    );
    const { status } = await postJson(app, "/api/find-literal", {
      pattern: "TODO",
      path: join(root, "alpha"),
    });
    expect(status).toBe(404);
  });

  it("returns shaped matches with a deduped file count", async () => {
    const findLiteralMatches = vi.fn(() => [
      {
        projectId: "p1",
        projectName: "alpha",
        relPath: "a.ts",
        chunkKind: "function",
        chunkStartLine: 1,
        chunkEndLine: 5,
        line: 2,
        column: 3,
        lineText: "const TODO = 1;",
      },
      {
        projectId: "p1",
        projectName: "alpha",
        relPath: "a.ts",
        chunkKind: "function",
        chunkStartLine: 1,
        chunkEndLine: 5,
        line: 4,
        column: 3,
        lineText: "// TODO again",
      },
    ]);
    const app = appWith(
      mountFindLiteral,
      fakeConfig(),
      fakeRuntime({ state: { findLiteralMatches: findLiteralMatches as never } }),
    );
    const { status, body } = await postJson(app, "/api/find-literal", { pattern: "TODO" });
    expect(status).toBe(200);
    const payload = body as { matches: unknown[]; fileCount: number };
    expect(payload.matches).toHaveLength(2);
    expect(payload.fileCount).toBe(1); // both matches in the same file
  });
});
