/**
 * Regression test for #371 / #373: files under `.claude/`, `.cursor/`,
 * `.aider/` must end up indexed and surface-able via find_literal.
 * Previously these dirs were in `ignored_dirs` under the "AI tooling
 * state" label, which silently dropped them — an agent doing an audit
 * for a placeholder token would miss the canonical rules file
 * defining the placeholder.
 *
 * This is a full-stack pass: filter → chunker → indexer → state →
 * findLiteralMatches. If any link in the chain regresses, the test
 * fails. Separate from the pure filter unit tests because those only
 * pin the `shouldIndex` decision; this one proves the indexed bytes
 * actually flow through to the audit-shape tool.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectIndexer } from "../../src/indexing/indexer.js";
import type { Project } from "../../src/models.js";
import type { StateStore } from "../../src/storage/index.js";
import { type IndexerFixture, makeIndexerFixture } from "../helpers/indexer-fixture.js";

let f: IndexerFixture;
let projectRoot: string;
let state: StateStore;
let indexer: ProjectIndexer;

beforeEach(async () => {
  // The fixture wires the real-world filter flow (`combinedGitignore(p.root)`),
  // which exercises the built-in auto-include (#375) — without it, the
  // .git/info/exclude entries written below would cause `.claude/`,
  // `.cursor/`, `.aider/` files to be skipped, regressing #371/#373
  // silently. Files written here are picked up because the filter is
  // constructed lazily per project at index time.
  f = await makeIndexerFixture("loctx-claude-");
  ({ projectRoot, state, indexer } = f);
  mkdirSync(join(projectRoot, ".git", "info"), { recursive: true });
  mkdirSync(join(projectRoot, ".claude", "commands"), { recursive: true });
  mkdirSync(join(projectRoot, ".cursor"), { recursive: true });

  // Project rules + slash command def in .claude/ — the #371 case.
  writeFileSync(
    join(projectRoot, ".claude", "CLAUDE.md"),
    [
      "# Project rules",
      "",
      "When the user mentions the {{customer-name}} placeholder,",
      "substitute the bound customer at compile time.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(projectRoot, ".claude", "commands", "new-blueprint.md"),
    "# /new-blueprint — scaffold a connector blueprint\n",
  );
  // Cursor rules for the same hidden-dir family.
  writeFileSync(
    join(projectRoot, ".cursor", "rules.md"),
    "# Cursor rules: use {{customer-name}} sparingly\n",
  );
  // A regular source file to compare against — must also surface.
  writeFileSync(
    join(projectRoot, "src", "compile.ts"),
    [
      "export function substitute(input: string): string {",
      "  return input.replace('{{customer-name}}', 'acme');",
      "}",
      "",
    ].join("\n"),
  );

  // Simulate the real-world #375 case: ~/.gitignore_global on most
  // developer machines lists `.claude/`, `.cursor/`, `.aider/` to keep
  // AI tooling state out of git. We can't touch the actual
  // ~/.gitignore_global from a test, but `.git/info/exclude` feeds the
  // same root layer in `combinedGitignore`. If the auto-include works
  // here, it works for ~/.gitignore_global too.
  writeFileSync(
    join(projectRoot, ".git", "info", "exclude"),
    ".claude/\n.cursor/\n.aider/\n",
    "utf-8",
  );
});

afterEach(() => {
  f.cleanup();
});

function project(): Project {
  return f.project();
}

describe("indexer surfaces .claude/ + .cursor/ via find_literal (#371)", () => {
  it("indexProject covers .claude/CLAUDE.md and findLiteralMatches surfaces it", async () => {
    const p = project();
    await indexer.indexProject(p);

    const hits = state.findLiteralMatches("{{customer-name}}", { projectId: p.id });
    const relPaths = new Set(hits.map((h) => h.relPath));

    // Source file — sanity that the pipeline works.
    expect(relPaths.has("src/compile.ts")).toBe(true);
    // The actual #371 regression — .claude/CLAUDE.md must be in the
    // result set.
    expect(relPaths.has(".claude/CLAUDE.md")).toBe(true);
    // And .cursor/ for symmetry — same fix covers it.
    expect(relPaths.has(".cursor/rules.md")).toBe(true);
  });

  it("nested .claude/ subdirectories (commands/) also surface", async () => {
    const p = project();
    await indexer.indexProject(p);

    // /new-blueprint command file lives at .claude/commands/new-blueprint.md
    // — the chunker's coverage-gap fill (#362) means a 1-line markdown
    // file ends up with a chunk regardless, so this should appear too.
    const hits = state.findLiteralMatches("new-blueprint", { projectId: p.id });
    expect(hits.some((h) => h.relPath === ".claude/commands/new-blueprint.md")).toBe(true);
  });
});
