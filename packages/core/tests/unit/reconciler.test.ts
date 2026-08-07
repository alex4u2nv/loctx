import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectIndexer } from "../../src/indexing/indexer.js";
import { Reconciler } from "../../src/indexing/reconciler.js";
import { type Project, projectId } from "../../src/models.js";
import type { StateStore } from "../../src/storage/index.js";
import { type IndexerFixture, makeIndexerFixture } from "../helpers/indexer-fixture.js";

let f: IndexerFixture;
let projectRoot: string;
let state: StateStore;
let reconciler: Reconciler;
let indexer: ProjectIndexer;

beforeEach(async () => {
  f = await makeIndexerFixture("loctx-recon-");
  ({ projectRoot, state, indexer } = f);
  reconciler = new Reconciler(state, indexer);
});

afterEach(() => {
  f.cleanup();
});

function makeProject(): Project {
  return f.project();
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
    // Snapshot the post-first-pass state. A truly idempotent rerun
    // must leave file count, chunk count, and the per-file content_sha
    // bit-for-bit identical (#167) — not just `reindexed=0`, which
    // wouldn't catch a regression that re-embedded but coincidentally
    // produced the same chunk ids.
    const beforeFiles = state.listFiles(project.id).map((f) => ({
      relPath: f.relPath,
      contentSha: f.contentSha,
    }));
    const beforeFileId = state.listFiles(project.id)[0]?.fileId;
    const beforeChunks = beforeFileId !== undefined ? state.listChunks(beforeFileId).length : 0;

    const second = await reconciler.reconcileProject(project);
    expect(second.pruned).toBe(0);
    expect(second.reindexed).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);

    const afterFiles = state.listFiles(project.id).map((f) => ({
      relPath: f.relPath,
      contentSha: f.contentSha,
    }));
    const afterChunks = beforeFileId !== undefined ? state.listChunks(beforeFileId).length : 0;
    expect(afterFiles).toEqual(beforeFiles);
    expect(afterChunks).toBe(beforeChunks);
  });

  it("does not stamp last_reconciled_at when indexProject throws (#194)", async () => {
    writeFileSync(join(projectRoot, "src", "auth.ts"), "export function authenticate() {}\n");
    const project = makeProject();
    await reconciler.reconcileProject(project);
    const stampedFirst = state.listProjects().find((p) => p.id === project.id)?.lastReconciledAt;
    expect(stampedFirst).not.toBeNull();

    // Sabotage indexProject by stubbing it to reject. The reconciler must
    // surface the failure AND must not advance last_reconciled_at, so a
    // subsequent doctor pass shows the project as drifted.
    const original = indexer.indexProject.bind(indexer);
    indexer.indexProject = async () => {
      throw new Error("simulated indexer failure");
    };
    try {
      await expect(reconciler.reconcileProject(project)).rejects.toThrow(
        "simulated indexer failure",
      );
    } finally {
      indexer.indexProject = original;
    }

    const stampedAfterFail = state
      .listProjects()
      .find((p) => p.id === project.id)?.lastReconciledAt;
    // Unchanged from the first successful pass — the failed reconcile must
    // not have advanced the stamp.
    expect(stampedAfterFail).toBe(stampedFirst);
  });

  it("clears rebuild_pending_at the moment a project finishes (#46 follow-up)", async () => {
    // Previously the clear ran in start.ts's post-batch loop after
    // reconcileAll resolved, so a mid-batch daemon kill left the flag
    // set forever and the next start re-resumed the rebuild from
    // scratch. Now reconcileProject itself clears the flag per-project
    // on success.
    writeFileSync(join(projectRoot, "src", "auth.ts"), "export function authenticate() {}\n");
    const project = makeProject();
    // Persist a rebuild intent the way `loctx rebuild` does.
    state.upsertProjectWithActive(project, true);
    state.markProjectRebuildPending(project.id);
    expect(state.listProjectsWithRebuildPending().map((p) => p.id)).toContain(project.id);

    await reconciler.reconcileProject(project);

    expect(state.listProjectsWithRebuildPending().map((p) => p.id)).not.toContain(project.id);
  });

  it("does NOT clear rebuild_pending_at when indexProject throws", async () => {
    // The clear must obey the same success gate as last_reconciled_at:
    // a failed reconcile leaves the rebuild marker so the next startup
    // tries again from the priority queue.
    writeFileSync(join(projectRoot, "src", "auth.ts"), "export function authenticate() {}\n");
    const project = makeProject();
    state.upsertProjectWithActive(project, true);
    state.markProjectRebuildPending(project.id);

    const original = indexer.indexProject.bind(indexer);
    indexer.indexProject = async () => {
      throw new Error("simulated indexer failure");
    };
    try {
      await expect(reconciler.reconcileProject(project)).rejects.toThrow();
    } finally {
      indexer.indexProject = original;
    }
    expect(state.listProjectsWithRebuildPending().map((p) => p.id)).toContain(project.id);
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
    const otherRoot = join(f.tmp, "other");
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
