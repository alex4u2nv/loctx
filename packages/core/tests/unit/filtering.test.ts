import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeProject } from "../../src/discovery.js";
import {
  FilterReason,
  type FilteringRules,
  ProjectFilter,
  loadFilteringRules,
  withOverrides,
} from "../../src/filtering.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let projectRoot: string;
let defaultRules: FilteringRules;

beforeEach(() => {
  tmp = mkTmpDir();
  projectRoot = join(tmp, "repo");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, ".git"));
  defaultRules = loadFilteringRules({ overrideDir: join(tmp, "no-overrides") });
});
afterEach(() => {
  rmTmpDir(tmp);
});

function write(path: string, content: string | Buffer = "") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function freshFilter(rules?: FilteringRules) {
  return new ProjectFilter(makeProject(projectRoot), rules ?? defaultRules);
}

describe("ProjectFilter", () => {
  it("skips ignored directories anywhere in the path", () => {
    const f = write(join(projectRoot, "node_modules", "lib", "x.js"), "console.log(1)");
    const decision = freshFilter().shouldIndex(f);
    expect(decision.shouldIndex).toBe(false);
    expect(decision.reason).toBe(FilterReason.IGNORED_DIRECTORY);
    expect(decision.detail).toBe("node_modules");
  });

  it("skips .git/", () => {
    const f = write(join(projectRoot, ".git", "HEAD"), "ref: x");
    expect(freshFilter().shouldIndex(f).reason).toBe(FilterReason.IGNORED_DIRECTORY);
  });

  it("skips a watcher event whose path equals the project root itself", () => {
    // @parcel/watcher occasionally fires a synthetic event for the root.
    // The old code passed rel="" to gitignore.ignores(), which throws and
    // bubbled up to a libc++ SIGABRT that killed the daemon mid-pass.
    // Reject early as IGNORED_DIRECTORY instead.
    const decision = freshFilter().shouldIndex(projectRoot);
    expect(decision.shouldIndex).toBe(false);
    expect(decision.reason).toBe(FilterReason.IGNORED_DIRECTORY);
    expect(decision.detail).toBe("<project root>");
  });

  it("skips secret files", () => {
    const f = write(join(projectRoot, ".env"), "API_KEY=hunter2");
    expect(freshFilter().shouldIndex(f).reason).toBe(FilterReason.SECRET);
  });

  it("allows .env.example", () => {
    const f = write(join(projectRoot, ".env.example"), "API_KEY=changeme");
    expect(freshFilter().shouldIndex(f).shouldIndex).toBe(true);
  });

  // Extended cloud/registry credential coverage (issue #175). The list
  // below is the default secret_globs surface — drop any of these and a
  // user could leak creds the first time their parent directory got
  // activated. Each line is the basename ProjectFilter checks.
  it.each([
    [".npmrc", "registry npm authToken"],
    [".pypirc", "pypi authToken"],
    [".netrc", "old-style http credentials"],
    [".pgpass", "postgres password file"],
    ["credentials", "AWS shared credentials"],
    ["token", "generic CI token drop-in"],
    ["gh-token", "GitHub CLI token"],
    ["gitlab-token", "GitLab token"],
    ["gitea-token", "Gitea token"],
    ["auth.json", "composer / generic auth"],
    ["service-account.json", "GCP service account key"],
    ["cluster.kubeconfig", "kubeconfig"],
  ])("skips %s (%s)", (name, _why) => {
    const f = write(join(projectRoot, name), "secret");
    expect(freshFilter().shouldIndex(f).reason).toBe(FilterReason.SECRET);
  });

  it("allows named files without extension", () => {
    const f = write(join(projectRoot, "Dockerfile"), "FROM scratch\n");
    expect(freshFilter().shouldIndex(f).shouldIndex).toBe(true);
  });

  it("skips unsupported extensions", () => {
    const f = write(join(projectRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(freshFilter().shouldIndex(f).reason).toBe(FilterReason.UNSUPPORTED_EXTENSION);
  });

  it("skips oversized files", () => {
    const rules = withOverrides(defaultRules, { maxFileSizeBytes: 64 });
    const f = write(join(projectRoot, "big.py"), "x = 1\n".repeat(200));
    expect(freshFilter(rules).shouldIndex(f).reason).toBe(FilterReason.OVERSIZED);
  });

  it("skips binary content even with supported extension", () => {
    const f = write(join(projectRoot, "weird.py"), Buffer.from("print('hi')\x00\x01"));
    expect(freshFilter().shouldIndex(f).reason).toBe(FilterReason.BINARY);
  });

  it("skips symlinks by default, follows when configured", () => {
    const target = write(join(projectRoot, "real.py"), "x = 1\n");
    const link = join(projectRoot, "link.py");
    symlinkSync(target, link);
    expect(freshFilter().shouldIndex(link).reason).toBe(FilterReason.SYMLINK);
    const followRules = withOverrides(defaultRules, { followSymlinks: true });
    expect(freshFilter(followRules).shouldIndex(link).shouldIndex).toBe(true);
  });

  it("skips paths outside project root", () => {
    const outside = write(join(tmp, "elsewhere.py"), "x = 1\n");
    expect(freshFilter().shouldIndex(outside).reason).toBe(FilterReason.OUTSIDE_PROJECT);
  });

  it("skips test/coverage output directories by default", () => {
    // Common build artifacts users don't want in the index. Each entry
    // matches the basename anywhere in the path. Without this, an
    // indexing pass on a JS repo will absorb Playwright reports
    // (test-results/, playwright-report/) and coverage HTML, eating
    // both the embedding budget and lexical signal-to-noise.
    const subPaths = [
      "test-results/run-1/output.json",
      "playwright-report/index.html",
      "coverage/lcov-report/index.html",
      ".nyc_output/coverage-final.json",
      "htmlcov/index.html",
    ];
    for (const rel of subPaths) {
      const f = write(join(projectRoot, rel), "{}");
      expect(freshFilter().shouldIndex(f).reason).toBe(FilterReason.IGNORED_DIRECTORY);
    }
  });

  it("skips lockfiles via noise_globs by default", () => {
    const f = write(join(projectRoot, "package-lock.json"), '{"lockfileVersion": 3}');
    expect(freshFilter().shouldIndex(f).reason).toBe(FilterReason.NOISE);
  });

  it("noise_globs covers the canonical lockfile basenames", () => {
    const names = [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "composer.lock",
      "Gemfile.lock",
      ".terraform.lock.hcl",
    ];
    for (const name of names) {
      const f = write(join(projectRoot, name), "x");
      expect(freshFilter().shouldIndex(f).reason).toBe(FilterReason.NOISE);
    }
  });

  it("allowed_named_files wins over noise_globs (Pipfile.lock stays indexed)", () => {
    // Pipfile.lock is explicitly opted-in via allowed_named_files; the
    // opt-in must beat noise_globs so users keep their curated coverage.
    const f = write(join(projectRoot, "Pipfile.lock"), "[meta]\n");
    expect(freshFilter().shouldIndex(f).shouldIndex).toBe(true);
  });

  it("accepts a normal Python file", () => {
    const f = write(join(projectRoot, "src", "app.py"), "def hi():\n    return 1\n");
    const decision = freshFilter().shouldIndex(f);
    expect(decision.shouldIndex).toBe(true);
    expect(decision.reason).toBe(FilterReason.OK);
  });
});
