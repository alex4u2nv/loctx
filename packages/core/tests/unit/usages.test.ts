/**
 * findSymbolUsages (#449) — the shared resolve-scope → findSymbol sweep
 * behind the MCP tool, the REST endpoint, and the CLI fallback. The key
 * behavior is the #276 monorepo case: a path inside an UNINDEXED inner
 * package (own package.json, no index rows) must widen to the indexed
 * parent with a warning, not silently return zero hits.
 */

import { describe, expect, it } from "vitest";
import type { Project } from "../../src/models.js";
import { projectId } from "../../src/models.js";
import { findSymbolUsages } from "../../src/retrieval/usages.js";
import type { SymbolRefHit } from "../../src/storage/state.js";

const parent: Project = { id: projectId("parent"), name: "alpha", root: "/ws/alpha" };
const inner: Project = {
  id: projectId("inner1"),
  name: "core",
  root: "/ws/alpha/packages/core",
};

const defHit: SymbolRefHit = {
  symbol: "authenticate",
  kind: "def",
  line: 3,
  relPath: "src/auth.ts",
  chunkStartLine: 1,
  chunkEndLine: 6,
  document: "export function authenticate() {}",
} as SymbolRefHit;

// discovery.resolveProject claims the inner marker; state.listProjects
// knows only the indexed parent — exactly the monorepo shape.
const discovery = {
  discoverProjects: () => [parent],
  resolveProject: (path: string) => {
    if (path.startsWith(inner.root)) return inner;
    return path.startsWith(parent.root) ? parent : null;
  },
};
const state = {
  listProjects: () => [
    {
      ...parent,
      active: true,
      lastIndexedAt: null,
      lastReconciledAt: null,
      rebuildPendingAt: null,
    },
  ],
  findSymbol: (id: string, _symbol: string) =>
    id === (parent.id as string) ? { defs: [defHit], refs: [] } : { defs: [], refs: [] },
};

describe("findSymbolUsages (#449)", () => {
  it("widens a nested unindexed-package path to the indexed parent with a warning (#276)", () => {
    const result = findSymbolUsages(
      discovery,
      state as never,
      "authenticate",
      "/ws/alpha/packages/core/src",
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.projects.map((p) => p.project.id)).toEqual([parent.id]);
    expect(result.projects[0]?.defs).toEqual([defHit]);
    expect(result.warnings.join(" ")).toContain("unindexed inner project core");
  });

  it("returns outside-indexed for a path no indexed project contains", () => {
    const result = findSymbolUsages(discovery, state as never, "authenticate", "/elsewhere");
    expect(result.kind).toBe("outside-indexed");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("sweeps every discovered project when no path is given", () => {
    const result = findSymbolUsages(discovery, state as never, "authenticate");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.projects).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("omits projects with zero hits", () => {
    const quiet = {
      ...state,
      findSymbol: () => ({ defs: [], refs: [] }),
    };
    const result = findSymbolUsages(discovery, quiet as never, "nothing");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.projects).toEqual([]);
  });
});
