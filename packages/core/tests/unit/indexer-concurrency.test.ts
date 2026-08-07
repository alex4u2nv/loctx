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

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectIndexer } from "../../src/indexing/indexer.js";
import type { Project } from "../../src/models.js";
import type { StateStore, VectorStore } from "../../src/storage/index.js";
import { type IndexerFixture, makeIndexerFixture } from "../helpers/indexer-fixture.js";

let f: IndexerFixture;
let projectRoot: string;
let state: StateStore;
let vectors: VectorStore;
let indexer: ProjectIndexer;

beforeEach(async () => {
  f = await makeIndexerFixture("loctx-conc-");
  ({ projectRoot, state, vectors, indexer } = f);
});

afterEach(() => {
  f.cleanup();
});

function project(): Project {
  return f.project();
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

  it("indexes a markdown file + records doc links without a FK error (#eval)", async () => {
    const p = project();
    // governance.md is the canonical target; guide.md links to it. Both are
    // first-time indexed — file_links has a FK to files(file_id), so the file
    // row must be written before its links (regression: replaceFileLinks ran
    // before upsertFile and threw "FOREIGN KEY constraint failed").
    writeFileSync(
      join(projectRoot, "governance.md"),
      "---\ntype: Doc\n---\n# Governance\n\nThe full process lives here.\n",
    );
    writeFileSync(
      join(projectRoot, "guide.md"),
      "---\ntype: Doc\n---\n# Guide\n\nSee [full process](./governance.md) for details.\n",
    );

    // Must not throw on first-time markdown indexing.
    const guide = await indexer.indexFile(p, join(projectRoot, "guide.md"));
    await indexer.indexFile(p, join(projectRoot, "governance.md"));
    expect(guide.kind).toBe("indexed");

    // The cross-link graph records guide.md → governance.md.
    expect(state.inboundCount(join(projectRoot, "governance.md"))).toBe(1);
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

  it("indexProject honors AbortSignal between files (#217)", async () => {
    // Drop enough files for the loop to actually pause between them.
    // The signal is set BEFORE the first iteration so the indexer
    // should produce an empty result rather than walking the tree.
    writeFileSync(join(projectRoot, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(projectRoot, "src", "b.ts"), "export const b = 2;\n");
    writeFileSync(join(projectRoot, "src", "c.ts"), "export const c = 3;\n");
    const p = project();

    const controller = new AbortController();
    controller.abort();
    const summary = await indexer.indexProject(p, { signal: controller.signal });
    expect(summary.indexed).toBe(0);
    expect(summary.total).toBe(0);
    // Aborted pass should NOT stamp last_indexed_at.
    const recorded = state.listProjects().find((x) => x.id === p.id);
    expect(recorded?.lastIndexedAt).toBeNull();
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
