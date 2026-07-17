/**
 * resolveGitSource + hashBoundaries (#468).
 *
 * The headline is the #468 fix: the search-root probe must NOT bind a
 * local checkout that doesn't contain the pinned sha, or a v2 gold set
 * pinning a foreign repo (run from inside loctx) resolves the local
 * loctx repo and then fails at `git worktree add <foreign-sha>`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashBoundaries, resolveGitSource } from "../src/corpus.js";

const tmpDirs: string[] = [];

function makeRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "loctx-eval-repo-"));
  tmpDirs.push(dir);
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString();
  execFileSync("git", ["init", "-q", dir]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "file.txt"), "hello");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  return { dir, sha };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveGitSource (#468)", () => {
  it("uses a search-root repo that contains the pinned sha (local fast path)", () => {
    const repo = makeRepo();
    const src = resolveGitSource("https://github.com/some/foreign", [repo.dir], repo.sha);
    expect(src.kind).toBe("local");
    if (src.kind !== "local") return;
    expect(existsSync(join(src.path, ".git"))).toBe(true);
  });

  it("does NOT bind a local repo lacking the pinned sha — falls back to clone (#468)", () => {
    // The local repo on the search path does NOT contain the pinned sha
    // (a foreign v2 corpus). It must be rejected and we clone instead.
    const repo = makeRepo();
    const foreignSha = "abcdef0123456789abcdef0123456789abcdef01"; // not in `repo`
    expect(repo.sha).not.toBe(foreignSha);
    const src = resolveGitSource("https://github.com/some/foreign", [repo.dir], foreignSha);
    expect(src.kind).toBe("url");
    if (src.kind !== "url") return;
    expect(src.url).toBe("https://github.com/some/foreign");
  });

  it("falls back to a URL clone when no search root contains the sha", () => {
    const src = resolveGitSource(
      "https://github.com/some/foreign",
      [tmpdir()],
      "deadbeef".repeat(5),
    );
    expect(src.kind).toBe("url");
  });

  it("accepts an explicit on-disk path that contains the sha", () => {
    const repo = makeRepo();
    const src = resolveGitSource(repo.dir, [], repo.sha);
    expect(src.kind).toBe("local");
    if (src.kind !== "local") return;
    expect(existsSync(join(src.path, ".git"))).toBe(true);
  });

  it("skips an explicit on-disk path that lacks the sha", () => {
    const repo = makeRepo();
    const absentSha = "abcdef0123456789abcdef0123456789abcdef01"; // not in `repo`
    const src = resolveGitSource(repo.dir, [], absentSha);
    expect(src.kind).toBe("url"); // repo.dir rejected, nothing else → clone repo.dir as URL
  });

  it("without a sha, keeps the legacy behavior (first .git ancestor wins)", () => {
    const repo = makeRepo();
    const src = resolveGitSource("https://github.com/some/foreign", [repo.dir]);
    expect(src.kind).toBe("local");
  });
});

describe("hashBoundaries", () => {
  it("is deterministic for the same boundary set", () => {
    const b = ["a.ts:1-10", "a.ts:11-20", "b.ts:1-5"];
    expect(hashBoundaries(b)).toBe(hashBoundaries([...b]));
  });

  it("changes when a boundary changes", () => {
    const base = ["a.ts:1-10", "b.ts:1-5"];
    expect(hashBoundaries(base)).not.toBe(hashBoundaries(["a.ts:1-11", "b.ts:1-5"]));
  });

  it("is a stable 64-char sha256 hex digest", () => {
    expect(hashBoundaries(["x:1-2"])).toMatch(/^[0-9a-f]{64}$/);
  });
});
