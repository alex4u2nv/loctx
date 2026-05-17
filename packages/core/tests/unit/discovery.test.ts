import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_MARKERS,
  WorkspaceDiscovery,
  chunkIdFor,
  fileIdFor,
  makeProject,
  projectIdFor,
} from "../../src/discovery.js";
import type { FileId } from "../../src/models.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
beforeEach(() => {
  tmp = mkTmpDir();
});
afterEach(() => {
  rmTmpDir(tmp);
});

function gitInit(p: string) {
  mkdirSync(p, { recursive: true });
  mkdirSync(join(p, ".git"), { recursive: true });
}

describe("identity helpers", () => {
  it("project id is stable for same path", () => {
    const repo = join(tmp, "repo");
    gitInit(repo);
    expect(projectIdFor(repo)).toBe(projectIdFor(repo));
  });

  it("project id differs by path", () => {
    gitInit(join(tmp, "a"));
    gitInit(join(tmp, "b"));
    expect(projectIdFor(join(tmp, "a"))).not.toBe(projectIdFor(join(tmp, "b")));
  });

  it("file id changes with rel path, normalizes separator", () => {
    const repo = join(tmp, "repo");
    gitInit(repo);
    const project = makeProject(repo);
    expect(fileIdFor(project, "src/a.py")).not.toBe(fileIdFor(project, "src/b.py"));
    expect(fileIdFor(project, "src/a.py")).toBe(fileIdFor(project, "src\\a.py"));
  });

  it("chunk id format", () => {
    const cid = chunkIdFor("abcdef0123456789" as FileId, 1, 42, "deadbeef".repeat(5));
    expect(cid).toBe("abcdef0123456789:000001-000042:deadbeef");
  });
});

describe("WorkspaceDiscovery", () => {
  it("finds direct children with .git/", () => {
    gitInit(join(tmp, "alpha"));
    gitInit(join(tmp, "bravo"));
    mkdirSync(join(tmp, "not_a_repo"));
    const projects = new WorkspaceDiscovery([tmp]).discoverProjects();
    expect(projects.map((p) => p.name)).toEqual(["alpha", "bravo"]);
  });

  it("recurses up to max depth", () => {
    gitInit(join(tmp, "team", "service"));
    mkdirSync(join(tmp, "team", "service", "subpackage"));
    const projects = new WorkspaceDiscovery([tmp]).discoverProjects();
    expect(projects.length).toBe(1);
    expect(projects[0]?.name).toBe("service");
  });

  it("does not descend into a project's subdirs", () => {
    const outer = join(tmp, "outer");
    gitInit(outer);
    gitInit(join(outer, "vendored"));
    const projects = new WorkspaceDiscovery([tmp]).discoverProjects();
    expect(projects.map((p) => p.name)).toEqual(["outer"]);
  });

  it("findAbsorbedMarkers returns inner markers under a project root (#286)", () => {
    const outer = join(tmp, "outer");
    gitInit(outer);
    gitInit(join(outer, "inner-a"));
    gitInit(join(outer, "nested", "inner-b"));
    // Deeper marker inside an inner project should NOT be reported — we
    // stop descending once we hit an absorbed marker.
    gitInit(join(outer, "inner-a", "inner-of-inner"));
    const markers = new WorkspaceDiscovery([tmp]).findAbsorbedMarkers(outer);
    expect(markers.map((m) => m.relPath)).toEqual(["inner-a", "nested/inner-b"]);
    expect(markers.every((m) => m.marker === ".git")).toBe(true);
  });

  it("findAbsorbedMarkers is empty when there are no inner markers", () => {
    const outer = join(tmp, "outer");
    gitInit(outer);
    mkdirSync(join(outer, "src"), { recursive: true });
    writeFileSync(join(outer, "src", "a.ts"), "");
    expect(new WorkspaceDiscovery([tmp]).findAbsorbedMarkers(outer)).toEqual([]);
  });

  it("skips hidden directories", () => {
    gitInit(join(tmp, ".cache", "repo"));
    expect(new WorkspaceDiscovery([tmp]).discoverProjects()).toEqual([]);
  });

  it("resolveProject walks upward", () => {
    const repo = join(tmp, "repo");
    gitInit(repo);
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "x.txt"), "hi");
    const project = new WorkspaceDiscovery([tmp]).resolveProject(nested);
    expect(project?.root).toBe(repo);
  });

  it("resolveProject returns null outside any repo", () => {
    expect(new WorkspaceDiscovery([tmp]).resolveProject(tmp)).toBeNull();
  });

  it.each([0, 1])("max depth limits search at depth=%i", (maxDepth) => {
    gitInit(join(tmp, "a", "b", "c"));
    const projects = new WorkspaceDiscovery([tmp], { maxDepth }).discoverProjects();
    expect(projects).toEqual([]);
  });
});

describe("project discovery markers (#81)", () => {
  function withFile(dir: string, name: string, content = "") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  function withDir(dir: string, name: string) {
    mkdirSync(join(dir, name), { recursive: true });
  }

  it("discovers a non-git project via package.json", () => {
    withFile(join(tmp, "node-pkg"), "package.json", "{}");
    const hits = new WorkspaceDiscovery([tmp]).discoverWithMarkers();
    expect(hits).toHaveLength(1);
    expect(hits[0]?.marker).toBe("package.json");
    expect(hits[0]?.markerKind).toBe("build");
  });

  it("discovers via .idea (IDE marker)", () => {
    const root = join(tmp, "intellij-proj");
    mkdirSync(root, { recursive: true });
    withDir(root, ".idea");
    const hits = new WorkspaceDiscovery([tmp]).discoverWithMarkers();
    expect(hits[0]?.marker).toBe(".idea");
    expect(hits[0]?.markerKind).toBe("ide");
  });

  it("discovers via *.code-workspace (suffix marker)", () => {
    const root = join(tmp, "vscode-multi");
    withFile(root, "team.code-workspace", "{}");
    const hits = new WorkspaceDiscovery([tmp]).discoverWithMarkers();
    expect(hits[0]?.markerKind).toBe("ide");
    expect(hits[0]?.marker).toBe(".code-workspace");
  });

  it("git wins over package.json at the same dir", () => {
    const root = join(tmp, "both");
    gitInit(root);
    writeFileSync(join(root, "package.json"), "{}");
    const hits = new WorkspaceDiscovery([tmp]).discoverWithMarkers();
    expect(hits).toHaveLength(1);
    expect(hits[0]?.markerKind).toBe("git");
    expect(hits[0]?.marker).toBe(".git");
  });

  it("does not treat node_modules contents as projects", () => {
    const root = join(tmp, "app");
    withFile(root, "package.json", "{}");
    const dep = join(root, "node_modules", "leftpad");
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "package.json"), "{}");
    const hits = new WorkspaceDiscovery([tmp]).discoverWithMarkers();
    expect(hits.map((h) => h.project.name)).toEqual(["app"]);
  });

  it("custom markers extend defaults via constructor option", () => {
    const root = join(tmp, "zig-like");
    withFile(root, "build.zig", "");
    const defaults = new WorkspaceDiscovery([tmp]).discoverWithMarkers();
    expect(defaults).toEqual([]);
    const extended = new WorkspaceDiscovery([tmp], {
      markers: [...DEFAULT_PROJECT_MARKERS, { name: "build.zig", kind: "file", group: "build" }],
    }).discoverWithMarkers();
    expect(extended.map((h) => h.marker)).toContain("build.zig");
  });

  it("discoverProjects returns same set as discoverWithMarkers without metadata", () => {
    withFile(join(tmp, "p1"), "package.json", "{}");
    withFile(join(tmp, "p2"), "Cargo.toml", "");
    const d = new WorkspaceDiscovery([tmp]);
    expect(
      d
        .discoverProjects()
        .map((p) => p.id)
        .sort(),
    ).toEqual(
      d
        .discoverWithMarkers()
        .map((h) => h.project.id)
        .sort(),
    );
  });

  it("resolveProject walks upward to nearest marker (any kind)", () => {
    const root = join(tmp, "py-proj");
    withFile(root, "pyproject.toml", "");
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });
    const project = new WorkspaceDiscovery([tmp]).resolveProject(nested);
    expect(project?.root).toBe(root);
  });
});
