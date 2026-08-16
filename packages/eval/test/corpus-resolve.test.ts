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

/**
 * Env for spawned git: strip the repo-targeting variables git exports
 * to hook processes (GIT_DIR & co). Without this, running this suite
 * from a lefthook pre-push hook made every `git -C <tmpdir>` operate
 * on the REAL repository — `-C` does not override GIT_DIR — which
 * re-initialized it, rewrote its config identity, and committed the
 * fixture tree onto the developer's branch (#513).
 */
function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE") {
      delete env[key];
    }
  }
  return env;
}

function makeRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "loctx-eval-repo-"));
  tmpDirs.push(dir);
  const env = scrubbedGitEnv();
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env }).toString();
  execFileSync("git", ["init", "-q", dir], { env });
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

  it("resolves local even when hook-style GIT_DIR/GIT_WORK_TREE point elsewhere (#530)", () => {
    // lefthook pre-push exports the pushing repo's GIT_DIR/GIT_WORK_TREE
    // into hook children; git lets those OVERRIDE `-C`, so the
    // sha-containment probe used to interrogate the WRONG repo and
    // report "not found" → kind "url". Simulate that environment.
    const target = makeRepo();
    const other = makeRepo(); // stands in for the pushing repo
    const saved = {
      GIT_DIR: process.env["GIT_DIR"],
      GIT_WORK_TREE: process.env["GIT_WORK_TREE"],
    };
    process.env["GIT_DIR"] = join(other.dir, ".git");
    process.env["GIT_WORK_TREE"] = other.dir;
    try {
      const src = resolveGitSource(target.dir, [], target.sha);
      expect(src.kind).toBe("local");
    } finally {
      if (saved.GIT_DIR === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved.GIT_DIR;
      if (saved.GIT_WORK_TREE === undefined) delete process.env["GIT_WORK_TREE"];
      else process.env["GIT_WORK_TREE"] = saved.GIT_WORK_TREE;
    }
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
