/**
 * Tests for live filter reload (#89): ProjectIndexer.reevaluateFilter
 * prunes files that are now matched by an ignore rule, while preserving
 * the secret-protection invariant (negation in .loctxignore can't pull
 * a baseline secret back into the index).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../../src/embeddings/index.js";
import { ProjectFilter, loadFilteringRules } from "../../src/filtering.js";
import { combinedGitignore } from "../../src/gitignore.js";
import { ProjectIndexer } from "../../src/indexing/indexer.js";
import { type Project, projectId } from "../../src/models.js";
import { StateStore, createVectorStore } from "../../src/storage/index.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let projectRoot: string;
let dataDir: string;
let state: StateStore;
let indexer: ProjectIndexer;

beforeEach(async () => {
  tmp = mkTmpDir("loctx-reeval-");
  projectRoot = join(tmp, "demo");
  dataDir = join(tmp, ".data");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  writeFileSync(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(dataDir, { recursive: true });

  state = new StateStore(join(dataDir, "state.sqlite3"));
  const embeddings = new FakeEmbeddingProvider({ dimension: 8, normalize: true });
  await embeddings.ensureReady?.();
  const vectors = createVectorStore(join(dataDir, "vectors"), embeddings.identity, state);
  const rules = loadFilteringRules();
  indexer = new ProjectIndexer(
    state,
    vectors,
    embeddings,
    (p: Project) => new ProjectFilter(p, rules, combinedGitignore(p.root)),
  );
});

afterEach(() => {
  state.close();
  rmTmpDir(tmp);
});

function makeProject(): Project {
  return Object.freeze({ id: projectId("demo-1"), name: "demo", root: projectRoot });
}

describe("ProjectIndexer.reevaluateFilter (#89)", () => {
  it("prunes a previously-indexed file that a new .loctxignore rule now excludes", async () => {
    const filePath = join(projectRoot, "src", "secret.ts");
    writeFileSync(filePath, "export const SECRET = 'hunter2';\n");
    const project = makeProject();

    // Index → file is in state.
    await indexer.indexProject(project);
    expect(state.listFiles(project.id).map((f) => f.relPath)).toContain("src/secret.ts");

    // Drop a .loctxignore rule that matches the file.
    writeFileSync(join(projectRoot, ".loctxignore"), "src/secret.ts\n");

    // Re-evaluate — file should be pruned.
    const summary = await indexer.reevaluateFilter(project);
    expect(summary.pruned).toBe(1);
    expect(summary.prunedRelPaths).toContain("src/secret.ts");
    expect(state.listFiles(project.id).map((f) => f.relPath)).not.toContain("src/secret.ts");
  });

  it("is a no-op when nothing changed", async () => {
    writeFileSync(join(projectRoot, "src", "auth.ts"), "export function auth() {}\n");
    const project = makeProject();
    await indexer.indexProject(project);
    const summary = await indexer.reevaluateFilter(project);
    expect(summary.pruned).toBe(0);
    expect(summary.checked).toBe(state.listFiles(project.id).length);
  });

  it("preserves secret protection: !.env in .loctxignore can't un-ignore a baseline secret", async () => {
    // .env is on the baseline secret-glob list. Even after a user adds
    // a negation rule to their .loctxignore, the SECRET decision wins.
    const envPath = join(projectRoot, ".env");
    writeFileSync(envPath, "API_KEY=hunter2\n");
    writeFileSync(join(projectRoot, ".loctxignore"), "!.env\n");

    const project = makeProject();
    // Direct shouldIndex check: should still be SECRET.
    const filter = new ProjectFilter(project, loadFilteringRules(), combinedGitignore(projectRoot));
    const decision = filter.shouldIndex(envPath);
    expect(decision.shouldIndex).toBe(false);
    expect(decision.reason).toBe("secret");

    // And the indexer's pass also leaves it absent.
    await indexer.indexProject(project);
    expect(state.listFiles(project.id).map((f) => f.relPath)).not.toContain(".env");
  });
});
