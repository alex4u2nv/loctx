import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { defaultPaths } from "../../src/index.js";

/**
 * Hermetic test `Config` over a temp workspace + data dir, using the
 * deterministic fake embedding provider (no model download, no network).
 *
 * Extracted from the byte-identical fixtures that `eval.test.ts` and the
 * mcp `scenarios.test.ts` had each grown — a 37-line frozen literal is
 * worth sharing even at two callers. Pass `overrides` to tweak a slice
 * (e.g. enable an analyzer, switch retrieval mode); everything else stays
 * at the hermetic defaults.
 */
export function makeTestConfig(
  workspaceRoot: string,
  dataDir: string,
  overrides: Partial<Config> = {},
): Config {
  const paths = defaultPaths();
  return Object.freeze({
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
    reconciliation: Object.freeze({ runOnStart: false, intervalSeconds: 0 }),
    discovery: Object.freeze({ extraMarkers: Object.freeze<string[]>([]), maxDepth: 4 }),
    analyzers: Object.freeze({
      backgroundEnabled: false,
      concurrency: 2,
      perTaskTimeoutMs: 60_000,
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
        enabled: false,
        command: "semgrep",
        ruleDirs: Object.freeze<string[]>([]),
        maxFindingsPerFile: 50,
      }),
      astGrep: Object.freeze({
        enabled: false,
        command: "ast-grep",
        ruleDirs: Object.freeze<string[]>([]),
        maxFindingsPerFile: 50,
      }),
    }),
    network: Object.freeze({ caCert: null, strictSsl: true, proxy: null }),
    source: null,
    sources: Object.freeze({}),
    ...overrides,
  });
}
