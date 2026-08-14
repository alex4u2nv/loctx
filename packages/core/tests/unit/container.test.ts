/**
 * Container wiring tests (CORE-1, CORE-11).
 *
 * CORE-1: analyzer activation used to be spelled out twice — once in
 * the indexing enqueue path, once in `backfillSpecs` — and the two had
 * drifted: the shipped semgrep default (`ruleDirs: []`,
 * `registryConfig: "p/default"`) ran during indexing while backfill
 * treated it as inactive and silently never touched already-indexed
 * files. Both paths now read the one `ANALYZERS` descriptor table;
 * these tests lock that policy (and the backfill fix) down.
 *
 * CORE-11: the external-tool probe cache used to be module-global
 * mutable state, unresettable between tests. It is now a
 * `ToolProbeCache` instance owned by each runtime.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_QUALITY_THRESHOLDS } from "../../src/analyzers/quality.js";
import type { AnalyzerConfig } from "../../src/config.js";
import { loadConfig } from "../../src/config.js";
import { ANALYZERS, buildRuntime, ToolProbeCache } from "../../src/container.js";
import { fileIdFor } from "../../src/discovery.js";
import { projectId } from "../../src/models.js";
import { watcherBus } from "../../src/watcher/index.js";
import { makeTestConfig } from "../helpers/config.js";
import { mkTmpDir, rmTmpDir } from "../helpers/tmp.js";

/** Deliberately not a real binary so probes fail fast (ENOENT). */
const MISSING_SEMGREP = "loctx-test-missing-semgrep";

let tmp: string;
let savedData: string | undefined;
let savedCfg: string | undefined;

beforeEach(() => {
  tmp = mkTmpDir("loctx-container-");
  savedData = process.env["LOCTX_DATA_DIR"];
  savedCfg = process.env["LOCTX_CONFIG_DIR"];
  process.env["LOCTX_DATA_DIR"] = join(tmp, "data");
  process.env["LOCTX_CONFIG_DIR"] = join(tmp, "cfg");
});
afterEach(() => {
  if (savedData === undefined) delete process.env["LOCTX_DATA_DIR"];
  else process.env["LOCTX_DATA_DIR"] = savedData;
  if (savedCfg === undefined) delete process.env["LOCTX_CONFIG_DIR"];
  else process.env["LOCTX_CONFIG_DIR"] = savedCfg;
  rmTmpDir(tmp);
});

function descriptor(name: string) {
  const found = ANALYZERS.find((a) => a.name === name);
  if (found === undefined) throw new Error(`no ANALYZERS row for '${name}'`);
  return found;
}

/**
 * Full analyzers section with only semgrep enabled, so runtime tests
 * exercise exactly one analyzer and never probe for real binaries
 * (the command is a guaranteed-missing name).
 */
function semgrepOnlyAnalyzers(semgrep: {
  readonly ruleDirs: ReadonlyArray<string>;
  readonly registryConfig: string;
  readonly enabled?: boolean;
}): AnalyzerConfig {
  return Object.freeze({
    backgroundEnabled: true,
    concurrency: 1,
    perTaskTimeoutMs: 5_000,
    lizard: Object.freeze({ enabled: false, command: "lizard" }),
    duplicates: Object.freeze({
      enabled: false,
      windowSize: 50,
      minUniqueTokens: 15,
      semantic: false,
      semanticThreshold: 92,
      semanticMaxChunks: 1500,
    }),
    semgrep: Object.freeze({
      enabled: semgrep.enabled ?? true,
      command: MISSING_SEMGREP,
      ruleDirs: Object.freeze([...semgrep.ruleDirs]),
      registryConfig: semgrep.registryConfig,
      bundledRules: false,
      maxFindingsPerFile: 50,
    }),
    astGrep: Object.freeze({
      enabled: false,
      command: "ast-grep",
      ruleDirs: Object.freeze<string[]>([]),
      registryConfig: "",
      bundledRules: false,
      maxFindingsPerFile: 50,
    }),
    definitions: Object.freeze({
      enabled: false,
      okfDefault: false,
      globs: Object.freeze<string[]>([]),
      schemas: Object.freeze<string[]>([]),
      requireFrontmatter: false,
      checkLinks: false,
      maxFindingsPerFile: 50,
    }),
    quality: Object.freeze({
      enabled: false,
      ...DEFAULT_QUALITY_THRESHOLDS,
      maxFindingsPerFile: 50,
      markdownRules: false,
      docDriftFloor: 35,
    }),
  });
}

describe("ANALYZERS activation policy (CORE-1)", () => {
  it("shipped default config leaves semgrep registry-config-only — and that IS active", () => {
    // Hermetic env (no user YAML) → built-in defaults.
    const config = loadConfig();
    expect(config.analyzers.semgrep.ruleDirs).toHaveLength(0);
    expect(config.analyzers.semgrep.registryConfig).not.toBe("");
    // The regression: backfill used to require non-empty ruleDirs, so
    // the shipped default indexed with semgrep but never backfilled.
    // Both paths now read this one predicate.
    expect(descriptor("semgrep").isActive(config)).toBe(true);
  });

  it("semgrep is inert with no rule dirs AND no registry config", () => {
    const config = makeTestConfig(tmp, join(tmp, "data"), {
      analyzers: semgrepOnlyAnalyzers({ ruleDirs: [], registryConfig: "" }),
    });
    expect(descriptor("semgrep").isActive(config)).toBe(false);
  });

  it("semgrep is active with local rule dirs even without a registry config", () => {
    const config = makeTestConfig(tmp, join(tmp, "data"), {
      analyzers: semgrepOnlyAnalyzers({ ruleDirs: ["/rules"], registryConfig: "" }),
    });
    expect(descriptor("semgrep").isActive(config)).toBe(true);
  });

  it("every analyzer has a distinct descriptor with a version", () => {
    const names = ANALYZERS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "lizard",
      "duplicates",
      "semgrep",
      "ast-grep",
      "definitions",
      "quality",
    ]);
    for (const a of ANALYZERS) expect(a.version).toBeGreaterThan(0);
  });
});

describe("backfillAnalyzers uses the same policy as indexing (CORE-1)", () => {
  it("backfills semgrep for already-indexed files under the registry-config-only default", async () => {
    // Arrange a tiny project.
    const projectRoot = join(tmp, "demo");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    writeFileSync(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(projectRoot, "src", "app.ts"), "export const answer = 42;\n");

    const config = makeTestConfig(projectRoot, join(tmp, "data"), {
      analyzers: semgrepOnlyAnalyzers({ ruleDirs: [], registryConfig: "p/default" }),
    });
    const runtime = await buildRuntime(config);
    try {
      // Index while the semgrep binary is (genuinely) unavailable — the
      // boot probe caches false, so indexing enqueues nothing. This is
      // the "enable/install the tool after the index is built" scenario
      // the backfill exists for.
      const project = Object.freeze({ id: projectId("demo-1"), name: "demo", root: projectRoot });
      const summary = await runtime.indexer.indexProject(project);
      expect(summary.indexed).toBeGreaterThan(0);

      // "Install" semgrep: pin availability on this runtime's own cache
      // (CORE-11 — pre-refactor this was process-global and unseedable).
      runtime.tools.seed(MISSING_SEMGREP, true);

      // Regression assertion: with the old duplicated backfillSpecs
      // (active = enabled && ruleDirs.length > 0) this returned 0 and
      // already-indexed files silently never got semgrep enrichments.
      const { enqueued } = await runtime.backfillAnalyzers(["semgrep"]);
      expect(enqueued).toBeGreaterThan(0);

      // Let the (failing — binary is fake) tasks settle before close so
      // the enrichment sink doesn't write into a closed StateStore.
      await runtime.enrichments.drainAll();
    } finally {
      await runtime.close();
    }
  });
});

describe("ToolProbeCache (CORE-11)", () => {
  it("instances are isolated — seeding one runtime's cache doesn't leak to another", () => {
    const a = new ToolProbeCache();
    const b = new ToolProbeCache();
    a.seed("some-tool", true);
    expect(a.ready("semgrep", "some-tool")).toBe(true);
    // b has no cached decision; ready() kicks a background probe and
    // reports unavailable for this round.
    expect(b.ready("semgrep", "some-tool")).toBe(false);
  });

  it("seed() pins the decision against later probes", async () => {
    const cache = new ToolProbeCache();
    cache.seed(MISSING_SEMGREP, true);
    // A real probe would fail (the binary doesn't exist); the pin wins.
    await expect(cache.probe("semgrep", MISSING_SEMGREP)).resolves.toBe(true);
    expect(cache.ready("semgrep", MISSING_SEMGREP)).toBe(true);
  });
});

describe("quality analyzer end-to-end (#522)", () => {
  /** All analyzers off except quality (pure-JS, no binary to probe). */
  function qualityOnlyAnalyzers(
    overrides: Partial<AnalyzerConfig["quality"]> = {},
  ): AnalyzerConfig {
    return Object.freeze({
      ...semgrepOnlyAnalyzers({ ruleDirs: [], registryConfig: "", enabled: false }),
      quality: Object.freeze({
        enabled: true,
        ...DEFAULT_QUALITY_THRESHOLDS,
        maxFindingsPerFile: 50,
        markdownRules: true,
        docDriftFloor: 35,
        ...overrides,
      }),
    });
  }

  function writeDemoProject(projectRoot: string, relPath: string, content: string): void {
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    writeFileSync(join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(projectRoot, relPath), content);
  }

  /** 5 exports + 60 filler lines: trips god-file at (50, 3) thresholds. */
  function godFileContent(): string {
    const exportLines = Array.from({ length: 5 }, (_, i) => `export const value${i} = ${i};`);
    const filler = Array.from({ length: 60 }, (_, i) => `const filler${i} = ${i};`);
    return `${[...exportLines, ...filler].join("\n")}\n`;
  }

  it("indexing persists quality findings through the enrichment queue", async () => {
    const projectRoot = join(tmp, "demo");
    writeDemoProject(projectRoot, join("src", "big.ts"), godFileContent());

    const config = makeTestConfig(projectRoot, join(tmp, "data"), {
      analyzers: qualityOnlyAnalyzers({ godFileNloc: 50, godFileExports: 3 }),
    });
    const runtime = await buildRuntime(config);
    try {
      const project = Object.freeze({ id: projectId("demo-1"), name: "demo", root: projectRoot });
      const summary = await runtime.indexer.indexProject(project);
      expect(summary.indexed).toBeGreaterThan(0);
      await runtime.enrichments.drainAll();

      const file = runtime.state.getFile(project.id, "src/big.ts");
      if (file === null) throw new Error("src/big.ts was not indexed");
      const row = runtime.state.getFileEnrichment(file.fileId, "quality");
      expect(row?.status).toBe("complete");
      const payload = JSON.parse(row?.payloadJson ?? "{}") as {
        analyzer?: string;
        findings?: ReadonlyArray<{ ruleId: string; severity: string }>;
      };
      expect(payload.analyzer).toBe("quality");
      expect(payload.findings?.map((f) => f.ruleId)).toContain("quality/god-file");
    } finally {
      await runtime.close();
    }
  });

  it("backfills quality for files indexed before the analyzer was enabled", async () => {
    const projectRoot = join(tmp, "demo");
    const dataDir = join(tmp, "data");
    writeDemoProject(projectRoot, join("src", "app.ts"), "export const answer = 42;\n");
    const project = Object.freeze({ id: projectId("demo-1"), name: "demo", root: projectRoot });

    // First runtime: quality off — files index with no quality enrichment.
    const off = await buildRuntime(
      makeTestConfig(projectRoot, dataDir, {
        analyzers: qualityOnlyAnalyzers({ enabled: false }),
      }),
    );
    try {
      await off.indexer.indexProject(project);
      await off.enrichments.drainAll();
      const file = off.state.getFile(project.id, "src/app.ts");
      if (file === null) throw new Error("src/app.ts was not indexed");
      expect(off.state.getFileEnrichment(file.fileId, "quality")).toBeNull();
    } finally {
      await off.close();
    }

    // Second runtime over the same data dir: quality on — backfill
    // catches up the already-indexed file without re-embedding.
    const on = await buildRuntime(
      makeTestConfig(projectRoot, dataDir, { analyzers: qualityOnlyAnalyzers() }),
    );
    try {
      const { enqueued } = await on.backfillAnalyzers(["quality"]);
      expect(enqueued).toBeGreaterThan(0);
      await on.enrichments.drainAll();
      const file = on.state.getFile(project.id, "src/app.ts");
      if (file === null) throw new Error("src/app.ts missing after backfill");
      expect(on.state.getFileEnrichment(file.fileId, "quality")?.status).toBe("complete");
    } finally {
      await on.close();
    }
  });

  it("ignores a stale-sha lizard row, then upgrades when a fresh lizard result lands", async () => {
    const projectRoot = join(tmp, "demo");
    writeDemoProject(projectRoot, join("src", "app.ts"), "export const answer = 42;\n");
    const project = Object.freeze({ id: projectId("demo-1"), name: "demo", root: projectRoot });
    const fileId = fileIdFor(project, "src/app.ts");
    const lizardPayload = {
      file: "app.ts",
      functions: [
        { name: "phantom", nloc: 2, ccn: 1, tokens: 8, parameters: 9, lineFrom: 1, lineTo: 2 },
      ],
    };

    const runtime = await buildRuntime(
      makeTestConfig(projectRoot, join(tmp, "data"), { analyzers: qualityOnlyAnalyzers() }),
    );
    try {
      // Plant a lizard row computed from DIFFERENT content before the
      // file indexes: quality must treat it as "lizard never ran" and
      // emit no long-params from the phantom 9-parameter function.
      runtime.state.upsertFileEnrichment({
        fileId,
        analyzer: "lizard",
        analyzerVersion: 1,
        contentSha: "stale-sha-from-previous-content",
        status: "complete",
        payloadJson: JSON.stringify(lizardPayload),
      });
      await runtime.indexer.indexProject(project);
      await runtime.enrichments.drainAll();

      const file = runtime.state.getFile(project.id, "src/app.ts");
      if (file === null) throw new Error("src/app.ts was not indexed");
      expect(file.fileId).toBe(fileId);
      const degraded = runtime.state.getFileEnrichment(fileId, "quality");
      expect(degraded?.status).toBe("complete");
      expect(degraded?.payloadJson ?? "").not.toContain("phantom");

      // A lizard result for the CURRENT content lands (fabricated task
      // through the real queue): the sink re-enqueues quality, which now
      // consumes the fresh payload and emits the long-params finding.
      runtime.enrichments.enqueue({
        id: `lizard:${fileId}`,
        analyzer: "lizard",
        analyzerVersion: 1,
        contentSha: file.contentSha,
        fileId,
        project,
        absPath: join(projectRoot, "src", "app.ts"),
        run: async () => lizardPayload,
      } as Parameters<typeof runtime.enrichments.enqueue>[0]);
      await runtime.enrichments.drainAll();

      const upgraded = runtime.state.getFileEnrichment(fileId, "quality");
      expect(upgraded?.status).toBe("complete");
      expect(upgraded?.payloadJson ?? "").toContain("quality/long-params");
      expect(upgraded?.payloadJson ?? "").toContain("phantom");
    } finally {
      await runtime.close();
    }
  });

  it("publishes coalesced analyzer bus events once enrichment settles (#526)", async () => {
    const projectRoot = join(tmp, "demo");
    writeDemoProject(projectRoot, join("src", "app.ts"), "export const answer = 42;\n");
    const received: Array<{ analyzer: string; projectId: string; completed: number }> = [];
    // Register the disposer immediately so a buildRuntime rejection
    // can't leak the listener onto the process-global bus.
    const unsubscribe = watcherBus.subscribe((e) => {
      if (e.type === "analyzer") {
        for (const b of e.batches) {
          received.push({ analyzer: b.analyzer, projectId: b.projectId, completed: b.completed });
        }
      }
    });
    try {
      const runtime = await buildRuntime(
        makeTestConfig(projectRoot, join(tmp, "data"), { analyzers: qualityOnlyAnalyzers() }),
      );
      try {
        const project = Object.freeze({
          id: projectId("demo-1"),
          name: "demo",
          root: projectRoot,
        });
        await runtime.indexer.indexProject(project);
        await runtime.enrichments.drainAll();
      } finally {
        // close() flushes the coalescer, so the batch event lands
        // without waiting out the 2s window.
        await runtime.close();
      }
    } finally {
      unsubscribe();
    }
    const quality = received.filter((e) => e.analyzer === "quality");
    expect(quality).toHaveLength(1);
    expect(quality[0]?.projectId).toBe("demo-1");
    expect(quality[0]?.completed).toBeGreaterThan(0);
  });

  it("markdown context rules: stale-ref fires, live refs don't, no drift in the row (#527)", async () => {
    const projectRoot = join(tmp, "demo");
    writeDemoProject(projectRoot, join("src", "app.ts"), "export const answer = 42;\n");
    writeFileSync(
      join(projectRoot, "GUIDE.md"),
      [
        "# Guide",
        "The runtime lives in `src/app.ts` and reads config.",
        "Legacy notes moved to [old notes](docs/removed-notes.md).",
        "",
      ].join("\n"),
    );

    const runtime = await buildRuntime(
      makeTestConfig(projectRoot, join(tmp, "data"), { analyzers: qualityOnlyAnalyzers() }),
    );
    try {
      const project = Object.freeze({ id: projectId("demo-1"), name: "demo", root: projectRoot });
      await runtime.indexer.indexProject(project);
      await runtime.enrichments.drainAll();

      const file = runtime.state.getFile(project.id, "GUIDE.md");
      if (file === null) throw new Error("GUIDE.md was not indexed");
      const row = runtime.state.getFileEnrichment(file.fileId, "quality");
      expect(row?.status).toBe("complete");
      const payload = JSON.parse(row?.payloadJson ?? "{}") as {
        findings?: ReadonlyArray<{ ruleId: string; message: string }>;
      };
      const stale = (payload.findings ?? []).filter((f) => f.ruleId === "quality/stale-ref");
      // The dangling link is flagged; the live backtick ref is not.
      expect(stale).toHaveLength(1);
      expect(stale[0]?.message).toContain("docs/removed-notes.md");
      // Drift is a query-time rule (#525) — it must NOT appear in the
      // enrichment row (cross-file signals don't persist per file).
      expect((payload.findings ?? []).some((f) => f.ruleId === "quality/doc-drift")).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});
