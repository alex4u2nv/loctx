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
import type { AnalyzerConfig } from "../../src/config.js";
import { loadConfig } from "../../src/config.js";
import { ANALYZERS, buildRuntime, ToolProbeCache } from "../../src/container.js";
import { projectId } from "../../src/models.js";
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
    duplicates: Object.freeze({ enabled: false, windowSize: 50, minUniqueTokens: 15 }),
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
    expect(names).toEqual(["lizard", "duplicates", "semgrep", "ast-grep", "definitions"]);
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
