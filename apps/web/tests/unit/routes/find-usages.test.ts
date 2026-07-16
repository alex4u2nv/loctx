/**
 * POST /api/find-usages — symbol validation, workspace-root confinement,
 * the #449/#276 nested-package widening (via core's findSymbolUsages),
 * and 404 for a path outside every indexed project.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { mountFindUsages } from "../../../server/api/find-usages.js";
import { appWith, fakeConfig, fakeRuntime, postJson } from "../helpers/harness.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loctx-fu-"));
  mkdirSync(join(root, "alpha", "src"), { recursive: true });
});

describe("POST /api/find-usages", () => {
  it("400s when symbol is missing or empty", async () => {
    const app = appWith(mountFindUsages, fakeConfig(), fakeRuntime());
    expect((await postJson(app, "/api/find-usages", {})).status).toBe(400);
    expect((await postJson(app, "/api/find-usages", { symbol: "  " })).status).toBe(400);
  });

  it("403s when path is outside every workspace_root", async () => {
    const app = appWith(mountFindUsages, fakeConfig({ workspaceRoots: [root] }), fakeRuntime());
    const { status } = await postJson(app, "/api/find-usages", {
      symbol: "authenticate",
      path: "/etc",
    });
    expect(status).toBe(403);
  });

  it("404s when a confined path is not inside any indexed project", async () => {
    // resolveProject returns null + listProjects empty → findSymbolUsages
    // reports outside-indexed → 404.
    const app = appWith(
      mountFindUsages,
      fakeConfig({ workspaceRoots: [root] }),
      fakeRuntime({ discovery: { resolveProject: () => null }, state: { listProjects: () => [] } }),
    );
    const { status } = await postJson(app, "/api/find-usages", {
      symbol: "authenticate",
      path: join(root, "alpha"),
    });
    expect(status).toBe(404);
  });

  it("returns per-project defs/refs on a whole-workspace sweep", async () => {
    const proj = { id: "p1", name: "alpha", root: join(root, "alpha") };
    const app = appWith(
      mountFindUsages,
      fakeConfig({ workspaceRoots: [root] }),
      fakeRuntime({
        discovery: { discoverProjects: () => [proj] as never },
        state: {
          findSymbol: ((id: string) =>
            id === "p1"
              ? {
                  defs: [
                    {
                      symbol: "authenticate",
                      kind: "def",
                      line: 3,
                      relPath: "src/auth.ts",
                      chunkStartLine: 1,
                      chunkEndLine: 6,
                      document: "export function authenticate() {}",
                    },
                  ],
                  refs: [],
                }
              : { defs: [], refs: [] }) as never,
        },
      }),
    );
    const { status, body } = await postJson(app, "/api/find-usages", { symbol: "authenticate" });
    expect(status).toBe(200);
    const payload = body as { defs: Array<{ relPath: string }>; refs: unknown[] };
    expect(payload.defs.map((d) => d.relPath)).toContain("src/auth.ts");
  });
});
