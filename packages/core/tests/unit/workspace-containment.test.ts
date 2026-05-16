/**
 * resolveUnderWorkspaceRoots — the path-confinement gate used by every
 * HTTP/MCP handler that accepts a user-supplied path. Tested against
 * realpathed temp directories so symlink escapes can be exercised.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveUnderWorkspaceRoots } from "../../src/discovery.js";

let tmp: string;

beforeEach(() => {
  // realpath the tmp dir so the canonical form matches what
  // resolveUnderWorkspaceRoots returns (macOS `/var/folders` is a
  // symlink to `/private/var/folders`).
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "loctx-wa-")));
});

afterEach(() => {
  // tmpdir cleanup is best-effort; subsequent runs make their own dirs.
});

describe("resolveUnderWorkspaceRoots", () => {
  it("returns the canonical path when the input is a workspace root itself", () => {
    const root = join(tmp, "workspace");
    mkdirSync(root);
    expect(resolveUnderWorkspaceRoots(root, [root])).toBe(root);
  });

  it("returns the canonical path for a descendant of a workspace root", () => {
    const root = join(tmp, "workspace");
    const project = join(root, "demo", "src");
    mkdirSync(project, { recursive: true });
    expect(resolveUnderWorkspaceRoots(project, [root])).toBe(project);
  });

  it("rejects an absolute path outside every configured root", () => {
    const root = join(tmp, "workspace");
    const other = join(tmp, "outside");
    mkdirSync(root);
    mkdirSync(other);
    expect(resolveUnderWorkspaceRoots(other, [root])).toBeNull();
  });

  it("does not treat a partial-prefix match as containment", () => {
    // `/.../workspace` and `/.../workspace-evil` share a string prefix
    // but the latter is not a descendant of the former.
    const root = join(tmp, "workspace");
    const evilSibling = join(tmp, "workspace-evil");
    mkdirSync(root);
    mkdirSync(evilSibling);
    expect(resolveUnderWorkspaceRoots(evilSibling, [root])).toBeNull();
  });

  it("follows symlink targets when checking containment", () => {
    // A symlink inside the workspace pointing OUT of it must not gain
    // membership through string-only prefix matching.
    const root = join(tmp, "workspace");
    const outside = join(tmp, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    const escapeLink = join(root, "escape");
    symlinkSync(outside, escapeLink);
    expect(resolveUnderWorkspaceRoots(escapeLink, [root])).toBeNull();
  });

  it("admits a symlinked workspace root by its real path", () => {
    const real = join(tmp, "real-workspace");
    const link = join(tmp, "linked-workspace");
    mkdirSync(real);
    symlinkSync(real, link);
    const project = join(link, "demo");
    mkdirSync(project);
    // Both forms (linked path and real path) of the workspace root must
    // resolve to the same canonical form so the comparison succeeds.
    expect(resolveUnderWorkspaceRoots(project, [link])).toBe(join(real, "demo"));
    expect(resolveUnderWorkspaceRoots(project, [real])).toBe(join(real, "demo"));
  });

  it("supports multiple workspace roots", () => {
    const a = join(tmp, "a");
    const b = join(tmp, "b");
    mkdirSync(a);
    mkdirSync(b);
    const projectA = join(a, "proj");
    const projectB = join(b, "proj");
    mkdirSync(projectA);
    mkdirSync(projectB);
    expect(resolveUnderWorkspaceRoots(projectA, [a, b])).toBe(projectA);
    expect(resolveUnderWorkspaceRoots(projectB, [a, b])).toBe(projectB);
    expect(resolveUnderWorkspaceRoots(join(tmp, "other"), [a, b])).toBeNull();
  });

  it("returns null for a path that does not exist on disk", () => {
    // realpath would throw; the helper falls back to plain resolve, but
    // we still reject if it doesn't sit under any root.
    const root = join(tmp, "workspace");
    mkdirSync(root);
    const phantom = join(tmp, "ghost", "missing.txt");
    expect(resolveUnderWorkspaceRoots(phantom, [root])).toBeNull();
  });

  it("rejects when workspace roots are empty", () => {
    const root = join(tmp, "workspace");
    mkdirSync(root);
    expect(resolveUnderWorkspaceRoots(root, [])).toBeNull();
  });

  it("ignores empty / bogus root entries without throwing", () => {
    const root = join(tmp, "workspace");
    mkdirSync(root);
    const project = join(root, "demo");
    mkdirSync(project);
    expect(resolveUnderWorkspaceRoots(project, ["", join(tmp, "does-not-exist"), root])).toBe(
      project,
    );
  });
});
