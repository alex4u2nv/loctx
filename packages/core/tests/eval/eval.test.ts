/**
 * Retrieval evaluation harness.
 *
 * Materialises three fake projects, indexes them with the deterministic
 * FakeEmbeddingProvider (no model download, no network), runs the curated
 * EVAL_CASES through the searcher, and asserts each expected chunk
 * appears in the top-`maxRank`. Aggregate metrics (hit@1/3/5, MRR,
 * zero-result rate) are printed for before/after comparison.
 *
 * Acts as a regression gate per issue #10: any change that drops a
 * curated case out of its expected top-k fails the test.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { type Runtime, WorkspaceDiscovery, buildRuntime, defaultPaths } from "../../src/index.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";
import { FIXTURE_PROJECTS, writeFixtureWorkspace } from "./fixtures.js";
import { EVAL_CASES } from "./queries.js";

let workspaceRoot: string;
let runtime: Runtime;
let dataDir: string;

beforeAll(async () => {
  workspaceRoot = mkTmpDir("loctx-eval-");
  dataDir = join(workspaceRoot, ".data");
  mkdirSync(dataDir, { recursive: true });
  writeFixtureWorkspace(workspaceRoot);

  // Real `loadConfig` would read XDG dirs; we synthesize one inline so the
  // test is hermetic. Path overrides go straight into `paths`.
  const paths = defaultPaths();
  const config: Config = Object.freeze({
    workspaceRoots: Object.freeze([workspaceRoot]),
    paths: Object.freeze({
      ...paths,
      dataDir,
      vectorDir: join(dataDir, "vectors"),
      stateDb: join(dataDir, "state.sqlite3"),
      logsDir: join(dataDir, "logs"),
    }),
    embedding: Object.freeze({
      provider: "fake",
      model: "hash",
      normalize: true,
      providerOverride: "fake",
    }),
    watcher: Object.freeze({ debounceMs: 0 }),
    daemon: Object.freeze({ port: 0, hostname: "localhost" }),
    retrieval: Object.freeze({ mode: "hybrid", rrfK: 60 }),
    source: null,
    projectSource: null,
    sources: Object.freeze({}),
  });

  runtime = await buildRuntime(config);

  // Index every fixture project. With FakeEmbeddingProvider this is pure
  // CPU work, no network, deterministic.
  const discovery = new WorkspaceDiscovery([workspaceRoot]);
  for (const project of discovery.discoverProjects()) {
    await runtime.indexer.indexProject(project);
  }
}, 30000);

afterAll(async () => {
  await runtime?.close();
  rmTmpDir(workspaceRoot);
});

interface CaseOutcome {
  readonly passed: boolean;
  readonly rank: number | null; // null when expected wasn't in the result list
  readonly maxRank: number;
}

describe("retrieval evaluation", () => {
  const outcomes: CaseOutcome[] = [];

  for (const c of EVAL_CASES) {
    it(`[${c.category}] ${c.name}`, async () => {
      const project = c.project ? FIXTURE_PROJECTS.find((p) => p.name === c.project) : undefined;
      const path = project
        ? c.subtree
          ? join(workspaceRoot, project.name, c.subtree)
          : join(workspaceRoot, project.name)
        : undefined;

      const response = await runtime.searcher.search({
        query: c.query,
        ...(path !== undefined ? { path } : {}),
        ...(c.language !== undefined ? { language: c.language } : {}),
        limit: 10,
      });

      const idx = response.results.findIndex((r) => r.relPath === c.expectedRelPath);
      const rank = idx === -1 ? null : idx + 1;
      const maxRank = c.maxRank ?? 5;
      const passed = rank !== null && rank <= maxRank;

      outcomes.push({ passed, rank, maxRank });

      if (!passed) {
        const top3 = response.results
          .slice(0, 3)
          .map((r) => `${r.relPath} (${r.sources.join("+")})`)
          .join(", ");
        throw new Error(
          `expected ${c.expectedRelPath} in top ${maxRank}; got rank=${rank ?? "miss"}, top3=[${top3}]`,
        );
      }
    });
  }

  it("aggregate metrics meet the regression threshold", () => {
    const total = outcomes.length;
    const ranks = outcomes.map((o) => o.rank);
    const hit1 = ranks.filter((r) => r !== null && r <= 1).length;
    const hit3 = ranks.filter((r) => r !== null && r <= 3).length;
    const hit5 = ranks.filter((r) => r !== null && r <= 5).length;
    const zero = ranks.filter((r) => r === null).length;
    const mrr = ranks.reduce<number>((acc, r) => acc + (r === null ? 0 : 1 / r), 0) / total;

    console.error(
      `\n[eval] cases=${total}  hit@1=${hit1}/${total}  hit@3=${hit3}/${total}  hit@5=${hit5}/${total}  zero=${zero}  MRR=${mrr.toFixed(3)}`,
    );

    // Threshold: at least 80% in top 5 (regression sentinel).
    // Tighten as quality improves.
    expect(hit5 / total).toBeGreaterThanOrEqual(0.8);
  });
});
