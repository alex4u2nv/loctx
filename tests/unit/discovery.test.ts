import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
