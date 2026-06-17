import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { combinedGitignore, LOCTXIGNORE_FILENAME } from "../../src/gitignore.js";
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

  it("honours .cursorignore and .aiderignore at the project root", () => {
    writeFileSync(join(root, ".cursorignore"), "secrets/\n", "utf-8");
    writeFileSync(join(root, ".aiderignore"), "private/\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec?.ignores("secrets/api-key")).toBe(true);
    expect(spec?.ignores("private/notes.md")).toBe(true);
    expect(spec?.ignores("src/app.ts")).toBe(false);
  });

  it("honours .ignore (universal cross-tool form)", () => {
    writeFileSync(join(root, ".ignore"), "*.bak\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec?.ignores("notes.bak")).toBe(true);
  });

  it("honours nested .gitignore scoped to its subdirectory", () => {
    writeFileSync(join(root, ".gitignore"), "*.log\n", "utf-8");
    mkdirSync(join(root, "frontend"), { recursive: true });
    writeFileSync(join(root, "frontend", ".gitignore"), "test-results/\n", "utf-8");

    const spec = combinedGitignore(root);
    // Root-level pattern still works.
    expect(spec?.ignores("debug.log")).toBe(true);
    // Nested rule scoped to frontend/.
    expect(spec?.ignores("frontend/test-results/run.json")).toBe(true);
    // Same dir name OUTSIDE frontend must NOT be ignored — that would
    // be the bug we're fixing (root-level merge would incorrectly
    // apply nested rules workspace-wide).
    expect(spec?.ignores("backend/test-results/run.json")).toBe(false);
    expect(spec?.ignores("test-results/run.json")).toBe(false);
  });

  it("nested .cursorignore scopes to its subdirectory too", () => {
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    writeFileSync(join(root, "apps", "web", ".cursorignore"), "fixtures/\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec?.ignores("apps/web/fixtures/big.json")).toBe(true);
    expect(spec?.ignores("apps/api/fixtures/big.json")).toBe(false);
  });

  it("auto-includes .claude/.cursor/.aider/ even when global excludes list them (#375)", () => {
    // `.git/info/exclude` is the test-controllable proxy for the
    // "global gitignore" layer (the real ~/.gitignore_global can't be
    // touched from a test). Both layers feed the same rootLines array
    // and the built-in negation sits between them and the per-project
    // rule files — so if this test passes for .git/info/exclude, the
    // same fix applies to ~/.gitignore_global.
    writeFileSync(join(root, ".git", "info", "exclude"), ".claude/\n.cursor/\n.aider/\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec).not.toBeNull();
    // The dirs themselves are re-included.
    expect(spec?.ignores(".claude/CLAUDE.md")).toBe(false);
    expect(spec?.ignores(".cursor/rules.md")).toBe(false);
    expect(spec?.ignores(".aider/conf.yml")).toBe(false);
    // Nested files under the auto-included dirs also surface.
    expect(spec?.ignores(".claude/commands/new-blueprint.md")).toBe(false);
  });

  it("`.loctxignore` can still exclude .claude/ when the user really wants that (#375)", () => {
    // Same global-style exclusion as above, but the project explicitly
    // adds `.claude/` to .loctxignore. .loctxignore evaluates AFTER the
    // built-in re-include, so the project's intent wins.
    writeFileSync(join(root, ".git", "info", "exclude"), ".claude/\n", "utf-8");
    writeFileSync(join(root, LOCTXIGNORE_FILENAME), ".claude/\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec?.ignores(".claude/CLAUDE.md")).toBe(true);
  });

  it("auto-include does NOT pollute non-AI-tooling directories (#375)", () => {
    // Sanity: the negation patterns are exact-dir, they must not
    // accidentally re-include arbitrary excluded directories.
    writeFileSync(join(root, ".git", "info", "exclude"), "secret-stuff/\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec?.ignores("secret-stuff/notes")).toBe(true);
  });

  it("skips noisy directories (node_modules) when discovering nested rule files", () => {
    mkdirSync(join(root, "node_modules", "foo"), { recursive: true });
    // A .gitignore deep inside node_modules should NOT load — we'd
    // burn cycles indexing thousands of dep dirs otherwise.
    writeFileSync(
      join(root, "node_modules", "foo", ".gitignore"),
      "this-should-not-load\n",
      "utf-8",
    );
    writeFileSync(join(root, ".gitignore"), "*.log\n", "utf-8");
    const spec = combinedGitignore(root);
    expect(spec?.ignores("debug.log")).toBe(true);
    // The pattern from node_modules/foo/.gitignore should not apply
    // outside node_modules. (Inside node_modules it doesn't matter; the
    // baseline filter ignores node_modules anyway.)
    expect(spec?.ignores("src/this-should-not-load")).toBe(false);
  });
});
