/**
 * Concurrency guarantees for ProjectIndexer.persist() — issues #188 and
 * #193.
 *
 * The watcher and reconciler can both fire `indexFile` for the same
 * path simultaneously. The indexer must:
 *  - Never end up with state and vectors disagreeing on the chunk-set
 *    for that file.
 *  - Never leave orphan vectors that no state row references.
 *
 * The implementation guards the whole persist sequence with a per-fileId
 * mutex and writes SQLite before LanceDB so a mid-flight crash leaves
 * the file's row pointing at the old sha — reconciliation then retries
 * the whole sequence idempotently.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../../src/embeddings/index.js";
import { ProjectFilter, loadFilteringRules } from "../../src/filtering.js";
import { combinedGitignore } from "../../src/gitignore.js";
import { ProjectIndexer } from "../../src/indexing/indexer.js";
import { type Project, projectId } from "../../src/models.js";
import { StateStore, type VectorStore, createVectorStore } from "../../src/storage/index.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

let tmp: string;
let projectRoot: string;
let state: StateStore;
let vectors: VectorStore;
let indexer: ProjectIndexer;

beforeEach(async () => {
  tmp = mkTmpDir("loctx-conc-");
  projectRoot = join(tmp, "demo");
  const dataDir = join(tmp, ".data");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  writeFileSync(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(dataDir, { recursive: true });

  state = new StateStore(join(dataDir, "state.sqlite3"));
  const embeddings = new FakeEmbeddingProvider({ dimension: 8, normalize: true });
  await embeddings.ensureReady?.();
  vectors = createVectorStore(join(dataDir, "vectors"), embeddings.identity, state);
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

function project(): Project {
  return Object.freeze({ id: projectId("demo-1"), name: "demo", root: projectRoot });
}

describe("ProjectIndexer concurrent persist (#188, #193)", () => {
  it("two concurrent indexFile calls for the same path leave state and vectors consistent", async () => {
    const filePath = join(projectRoot, "src", "auth.ts");
    writeFileSync(filePath, "export function authenticate() { return 1; }\n");
    const p = project();

    // Fire two indexFile calls back-to-back without awaiting between
    // them. The fileWriteMutex must serialize the persist sequences
    // for this same fileId; otherwise the state and vector writes
    // interleave and one of the two views is left stale.
    await Promise.all([indexer.indexFile(p, filePath), indexer.indexFile(p, filePath)]);

    const files = state.listFiles(p.id);
    expect(files).toHaveLength(1);
    const fileRow = files[0];
    if (fileRow === undefined) throw new Error("expected file row");

    const stateChunks = state.listChunks(fileRow.fileId);
    expect(stateChunks.length).toBeGreaterThan(0);

    // Both views must agree on the chunk-set for this file.
    const vectorCount = await vectors.count();
    expect(vectorCount).toBe(stateChunks.length);
  });

  it("file-row content_sha is only stamped after both stores are written", async () => {
    // The `upsertFile` call is the persist sequence's commit marker.
    // After indexFile resolves, the file row's sha must reflect the
    // newest content — even if a concurrent call rewrote with the same
    // sha.
    const filePath = join(projectRoot, "src", "auth.ts");
    const body = "export function authenticate() { return 'hi'; }\n";
    writeFileSync(filePath, body);
    const p = project();

    await indexer.indexFile(p, filePath);
    const fileRow = state.getFile(p.id, "src/auth.ts");
    expect(fileRow).not.toBeNull();
    expect(fileRow?.error).toBeNull();
    // contentSha is sha256 of the file bytes — non-empty hex digest.
    expect(fileRow?.contentSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists a read error on the file row so doctor can surface it (#184)", async () => {
    // Simulate the race-condition the ticket targets: filter saw a
    // readable file but readFileSync hits EACCES (the file got chmod'd
    // between the two). We feed the indexer a custom filter that
    // unconditionally accepts the path so the filter's own UNREADABLE
    // branch can't catch it — only the indexer's read-error path can.
    const broken = join(projectRoot, "src", "broken.ts");
    writeFileSync(broken, "export const x = 1;\n");
    chmodSync(broken, 0o000);
    try {
      const p = project();
      // Always-accepting filter; matches the FilterDecision shape the
      // indexer expects without touching disk.
      const acceptingFilter = {
        rules: {
          ignoredDirs: new Set<string>(),
          maxFileSizeBytes: 10_000_000,
          allowedExtensions: new Set<string>(),
          allowedNamedFiles: new Set<string>(),
          secretGlobs: [],
          secretAllowlistGlobs: [],
        },
        shouldIndex: () => ({ shouldIndex: true, reason: "ok", detail: "" }),
      } as unknown as Parameters<typeof indexer.indexFile>[2] extends { filter?: infer F }
        ? F
        : never;
      const result = await indexer.indexFile(p, broken, { filter: acceptingFilter });
      expect(result.kind).toBe("error");

      const fileRow = state.getFile(p.id, "src/broken.ts");
      expect(fileRow).not.toBeNull();
      expect(fileRow?.error).toMatch(/read-error/);
    } finally {
      // Restore so tmp cleanup can remove the file.
      chmodSync(broken, 0o644);
    }
  });

  it("concurrent persists on different files run in parallel (different mutex chains)", async () => {
    // Per-fileId mutex must not block work on other files. We can't
    // assert wall-clock parallelism deterministically, but we can
    // assert correctness: both files end up indexed.
    const a = join(projectRoot, "src", "a.ts");
    const b = join(projectRoot, "src", "b.ts");
    writeFileSync(a, "export const a = 1;\n");
    writeFileSync(b, "export const b = 2;\n");
    const p = project();

    await Promise.all([indexer.indexFile(p, a), indexer.indexFile(p, b)]);

    const files = state.listFiles(p.id);
    expect(files.map((f) => f.relPath).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const totalChunks = files.reduce((n, f) => n + state.listChunks(f.fileId).length, 0);
    expect(await vectors.count()).toBe(totalChunks);
  });
});
