import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceDiscovery, inventoryProjects, makeProject } from "../../src/discovery.js";
import { type Project, projectId } from "../../src/models.js";
import { StateStore } from "../../src/storage/state.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let state: StateStore;

beforeEach(() => {
  tmp = mkTmpDir();
  state = new StateStore(join(tmp, "state.sqlite3"));
});
afterEach(() => {
  state.close();
  rmTmpDir(tmp);
});

function fakeProjectAt(root: string, name = "proj"): Project {
  // Make a real .git dir so WorkspaceDiscovery picks it up.
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# x", "utf-8");
  return { id: projectId(name), name, root };
}

describe("inventoryProjects", () => {
  it("classifies a discovered-but-not-activated project as inactive", () => {
    const root = join(tmp, "alpha");
    fakeProjectAt(root, "alpha");
    const inv = inventoryProjects(new WorkspaceDiscovery([tmp]), state);
    expect(inv.active).toHaveLength(0);
    expect(inv.inactive.map((i) => i.project.name)).toContain("alpha");
    expect(inv.inactive[0]?.known).toBe(false);
    expect(inv.orphaned).toHaveLength(0);
  });

  it("classifies an activated project as active", () => {
    const root = join(tmp, "alpha");
    fakeProjectAt(root, "alpha");
    const discovered = makeProject(root);
    state.upsertProjectWithActive(discovered, true);

    const inv = inventoryProjects(new WorkspaceDiscovery([tmp]), state);
    expect(inv.active.map((a) => a.project.name)).toContain("alpha");
    expect(inv.inactive).toHaveLength(0);
    expect(inv.orphaned).toHaveLength(0);
  });

  it("classifies a project with active=0 in state as inactive (known)", () => {
    const root = join(tmp, "alpha");
    fakeProjectAt(root, "alpha");
    const discovered = makeProject(root);
    state.upsertProjectWithActive(discovered, false);

    const inv = inventoryProjects(new WorkspaceDiscovery([tmp]), state);
    expect(inv.inactive).toHaveLength(1);
    expect(inv.inactive[0]?.known).toBe(true);
  });

  it("classifies a project recorded in state but outside the roots as orphaned", () => {
    const orphanRoot = join(tmp, "stale");
    mkdirSync(orphanRoot, { recursive: true });
    state.upsertProjectWithActive(
      { id: projectId("stale01"), name: "stale", root: orphanRoot },
      true,
    );

    // workspace_roots points at a sibling dir that doesn't contain `stale`.
    const sibling = join(tmp, "actively-watched");
    mkdirSync(sibling, { recursive: true });
    const inv = inventoryProjects(new WorkspaceDiscovery([sibling]), state);
    expect(inv.active).toHaveLength(0);
    expect(inv.orphaned).toHaveLength(1);
    expect(inv.orphaned[0]?.reason).toBe("outside-roots");
    expect(inv.orphaned[0]?.rootExists).toBe(true);
  });

  it("flags missing-on-disk roots distinctly", () => {
    const ghost = join(tmp, "ghost-that-does-not-exist");
    state.upsertProjectWithActive({ id: projectId("ghost001"), name: "ghost", root: ghost }, true);
    const inv = inventoryProjects(new WorkspaceDiscovery([tmp]), state);
    expect(inv.active).toHaveLength(0);
    expect(inv.orphaned).toHaveLength(1);
    expect(inv.orphaned[0]?.rootExists).toBe(false);
    expect(inv.orphaned[0]?.reason).toBe("missing");
  });

  it("active projects carry forward their lastIndexedAt", () => {
    const root = join(tmp, "alpha");
    fakeProjectAt(root, "alpha");
    const discovered = makeProject(root);
    state.upsertProjectWithActive(discovered, true);
    state.markProjectIndexed(discovered.id, new Date("2026-04-01T00:00:00Z"));

    const inv = inventoryProjects(new WorkspaceDiscovery([tmp]), state);
    const active = inv.active.find((a) => a.project.root === root);
    expect(active?.lastIndexedAt).toBe("2026-04-01T00:00:00.000Z");
  });
});
