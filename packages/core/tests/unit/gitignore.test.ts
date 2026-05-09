import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCTXIGNORE_FILENAME, combinedGitignore } from "../../src/gitignore.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let root: string;

beforeEach(() => {
  root = mkTmpDir("loctx-gitignore-");
  mkdirSync(join(root, ".git", "info"), { recursive: true });
});

afterEach(() => {
  rmTmpDir(root);
});

describe("combinedGitignore", () => {
  // Note: tests don't assert null on a clean repo because the user's global
  // excludesfile may be configured outside the test sandbox. Each test below
  // checks for additive behavior of the project-local files.

  it("honours .gitignore at the project root", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules\n*.log\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec).not.toBeNull();
    expect(spec?.ignores("node_modules/foo")).toBe(true);
    expect(spec?.ignores("debug.log")).toBe(true);
    expect(spec?.ignores("src/app.ts")).toBe(false);
  });

  it("honours .git/info/exclude", () => {
    writeFileSync(join(root, ".git", "info", "exclude"), "secret-stuff/\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec?.ignores("secret-stuff/notes")).toBe(true);
  });

  it("honours .loctxignore alongside .gitignore", () => {
    writeFileSync(join(root, ".gitignore"), "build/\n", "utf-8");
    writeFileSync(join(root, LOCTXIGNORE_FILENAME), "vendor/\nfixtures/large/\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec).not.toBeNull();
    // Both files contribute.
    expect(spec?.ignores("build/output.js")).toBe(true);
    expect(spec?.ignores("vendor/lib.tar.gz")).toBe(true);
    expect(spec?.ignores("fixtures/large/dump.bin")).toBe(true);
    expect(spec?.ignores("src/app.ts")).toBe(false);
  });

  it("`.loctxignore` alone (no .gitignore) still produces a spec", () => {
    writeFileSync(join(root, LOCTXIGNORE_FILENAME), "*.snapshot\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec?.ignores("test.snapshot")).toBe(true);
  });

  it("layers .gitignore + .loctxignore additively", () => {
    writeFileSync(join(root, ".gitignore"), "*.log\n", "utf-8");
    writeFileSync(join(root, LOCTXIGNORE_FILENAME), "*.tmp\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec?.ignores("debug.log")).toBe(true); // from .gitignore
    expect(spec?.ignores("scratch.tmp")).toBe(true); // from .loctxignore
    expect(spec?.ignores("README.md")).toBe(false);
  });
});
