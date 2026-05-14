import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../../src/embeddings/index.js";
import { ProjectFilter, loadFilteringRules } from "../../src/filtering.js";
import { combinedGitignore } from "../../src/gitignore.js";
import { ProjectIndexer } from "../../src/indexing/indexer.js";
import { Reconciler } from "../../src/indexing/reconciler.js";
import { type Project, projectId } from "../../src/models.js";
import { StateStore, createVectorStore } from "../../src/storage/index.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let projectRoot: string;
let dataDir: string;
let state: StateStore;
let reconciler: Reconciler;
let indexer: ProjectIndexer;

beforeEach(async () => {
  tmp = mkTmpDir("loctx-recon-");
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
  reconciler = new Reconciler(state, indexer);
});

afterEach(() => {
  state.close();
  rmTmpDir(tmp);
});

function makeProject(): Project {
  return Object.freeze({ id: projectId("demo-1"), name: "demo", root: projectRoot });
}

describe("Reconciler (#14)", () => {
  it("indexes a fresh project and stamps last_reconciled_at", async () => {
    writeFileSync(join(projectRoot, "src", "auth.ts"), "export function authenticate() {}\n");
    const summary = await reconciler.reconcileProject(makeProject());
    expect(summary.reindexed).toBeGreaterThan(0);
    expect(summary.pruned).toBe(0);
    const recorded = state.listProjects().find((p) => p.id === "demo-1");
    expect(recorded?.lastReconciledAt).not.toBeNull();
  });

  it("prunes a file deleted on disk while the daemon was offline", async () => {
    const filePath = join(projectRoot, "src", "auth.ts");
    writeFileSync(filePath, "export function authenticate() {}\n");
    const project = makeProject();
    await reconciler.reconcileProject(project);
    expect(state.listFiles(project.id).length).toBe(1);

    rmSync(filePath);
    const summary = await reconciler.reconcileProject(project);
    expect(summary.pruned).toBe(1);
    expect(state.listFiles(project.id).length).toBe(0);
  });

  it("reindexes a file modified while the daemon was offline", async () => {
    const filePath = join(projectRoot, "src", "auth.ts");
    writeFileSync(filePath, "export function authenticate() {}\n");
    const project = makeProject();
    await reconciler.reconcileProject(project);

    // Same name, different body → sha changes → indexer reindexes.
    writeFileSync(filePath, "export function authenticateV2() { return 42; }\n");
    const summary = await reconciler.reconcileProject(project);
    expect(summary.reindexed).toBe(1);
    expect(summary.pruned).toBe(0);
  });

  it("is idempotent when nothing changed (no churn on second pass)", async () => {
    writeFileSync(join(projectRoot, "src", "auth.ts"), "export function authenticate() {}\n");
    const project = makeProject();
    await reconciler.reconcileProject(project);
    const second = await reconciler.reconcileProject(project);
    expect(second.pruned).toBe(0);
    expect(second.reindexed).toBe(0);
    // Skipped count == file count: every file already at sha.
    expect(second.skipped).toBeGreaterThanOrEqual(1);
  });

  it("prunes already-indexed files that a new ignore rule now excludes", async () => {
    // Sim the user's report: file is indexed first, then a matching
    // pattern is added to .gitignore (or global). Subsequent
    // reconciliation should drop the now-excluded file without
    // requiring a manual purge. Uses a fixture pattern that the
    // host's `~/.gitignore_global` is unlikely to already match.
    const targetPath = join(projectRoot, "src", "scratch.recyclebait.md");
    writeFileSync(join(projectRoot, "src", "keep.ts"), "export const x = 1;\n");
    writeFileSync(targetPath, "junk\n");
    const project = makeProject();
    await reconciler.reconcileProject(project);
    expect(
      state
        .listFiles(project.id)
        .map((f) => f.relPath)
        .sort(),
    ).toEqual(["src/keep.ts", "src/scratch.recyclebait.md"]);

    // Add a rule that matches the bait file.
    writeFileSync(join(projectRoot, ".gitignore"), "*.recyclebait.*\n");

    const summary = await reconciler.reconcileProject(project);
    expect(summary.pruned).toBe(1);
    expect(state.listFiles(project.id).map((f) => f.relPath)).toEqual(["src/keep.ts"]);
  });

  it("reconcileAll handles multiple projects and stamps each one", async () => {
    writeFileSync(join(projectRoot, "src", "auth.ts"), "export function authenticate() {}\n");
    const otherRoot = join(tmp, "other");
    mkdirSync(join(otherRoot, ".git"), { recursive: true });
    mkdirSync(join(otherRoot, "src"), { recursive: true });
    writeFileSync(join(otherRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(otherRoot, "src", "ratelimit.ts"), "export function limit() {}\n");

    const projects: Project[] = [
      makeProject(),
      Object.freeze({ id: projectId("other-1"), name: "other", root: otherRoot }),
    ];
    const summaries = await reconciler.reconcileAll(projects);
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.elapsedSeconds >= 0)).toBe(true);
    const recorded = state.listProjects();
    expect(recorded.every((p) => p.lastReconciledAt !== null)).toBe(true);
  });
});
