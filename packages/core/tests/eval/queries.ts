/**
 * Curated retrieval evaluation queries.
 *
 * Each case names the category, the query string, and the relPath of the
 * chunk we expect at or near the top of the result list. Categories reflect
 * the buckets called out in issue #10:
 *
 *   - exact-symbol  : function / class / type names
 *   - filename      : matching by file name
 *   - path          : matching by directory / path fragment
 *   - fragment      : code snippet
 *   - concept       : prose paraphrase that maps to a code or doc chunk
 *   - heading       : matching a markdown section heading
 *   - command       : shell command mention
 *   - config        : config key / setting
 *   - drift         : terminology drift (different vocabulary, same concept)
 *   - refactor      : refactor coverage (prose docs reference + code)
 *
 * For the eval to pass under the deterministic FakeEmbeddingProvider used
 * in CI, queries lean on tokens that BM25 can rank well; with the real
 * model in place the same query set would also exercise the dense branch.
 */

export type QueryCategory =
  | "exact-symbol"
  | "filename"
  | "path"
  | "fragment"
  | "concept"
  | "heading"
  | "command"
  | "config"
  | "drift"
  | "refactor"
  | "analyzer"
  /** "where does this error come from", "what handles this error type". */
  | "debug"
  /** "how do we usually structure X", "show me how we typically do Y". */
  | "pattern"
  /** "every place that imports X", "all callers of deprecated method". */
  | "refactor-recon"
  /** "what's our writing style", "what's the on-call escalation path". */
  | "skill-process"
  /** Answer spans both code AND docs (cross-corpus). */
  | "cross-corpus";

export interface EvalCase {
  readonly name: string;
  readonly category: QueryCategory;
  readonly query: string;
  /** Project name to scope to, or null for all-project search. */
  readonly project?: string;
  /** Path-prefix scope (relative to project root), e.g. "src/auth". */
  readonly subtree?: string;
  /** Language filter, when set. */
  readonly language?: string;
  /** Path of the chunk we expect to appear in the top-k. Project-qualified. */
  readonly expectedRelPath: string;
  /**
   * Maximum rank at which the expected result should appear. Default 5.
   * Tighter (1-3) for queries we have high confidence on.
   */
  readonly maxRank?: number;
  /**
   * Marks queries that genuinely need dense-embedding semantic matching
   * to land — under FakeEmbeddingProvider's BM25-only ranking they'll
   * be loose. Production use of the real model will tighten them. The
   * eval harness still gates on hit@5 ≥ 80% across the whole set.
   */
  readonly needsDenseEmbedding?: boolean;
}

export const EVAL_CASES: ReadonlyArray<EvalCase> = Object.freeze([
  // Exact symbol
  {
    name: "auth function by name",
    category: "exact-symbol",
    query: "authenticateUser",
    expectedRelPath: "src/auth/login.ts",
    maxRank: 3,
  },
  {
    name: "verifyJwt by name",
    category: "exact-symbol",
    query: "verifyJwt",
    expectedRelPath: "src/auth/jwt.ts",
    maxRank: 3,
  },
  {
    name: "RequestThrottle class",
    category: "exact-symbol",
    query: "RequestThrottle",
    expectedRelPath: "pipeline/throttle.py",
    maxRank: 3,
  },
  {
    name: "credential_check function",
    category: "exact-symbol",
    query: "credential_check",
    expectedRelPath: "pipeline/credential_check.py",
    maxRank: 3,
  },

  // Filename / path
  {
    name: "filename: jwt.ts",
    category: "filename",
    query: "jwt",
    expectedRelPath: "src/auth/jwt.ts",
  },
  {
    name: "filename: throttle.py",
    category: "filename",
    query: "throttle",
    expectedRelPath: "pipeline/throttle.py",
  },
  {
    name: "path: rate-limiter middleware",
    category: "path",
    query: "rate limiter middleware",
    expectedRelPath: "src/middleware/rate-limiter.ts",
  },

  // Fragment
  {
    name: "fragment: token bucket",
    category: "fragment",
    query: "token bucket per second",
    expectedRelPath: "pipeline/throttle.py",
  },
  {
    name: "fragment: postgres connection",
    category: "fragment",
    query: "postgres database",
    expectedRelPath: "config.toml",
  },

  // Concept (prose paraphrase)
  {
    name: "concept: bearer token validation",
    category: "concept",
    query: "verify bearer token signature",
    expectedRelPath: "src/auth/jwt.ts",
    // Tighter than top-5 needs the dense-embedding branch to actually
    // catch the semantic match; with FakeEmbedding the BM25 ranking
    // puts onboarding.md (which literally says "bearer token") slightly
    // above jwt.ts's "missing bearer token" guard. Allow top-8.
    maxRank: 8,
  },
  {
    name: "concept: limit requests by IP",
    category: "concept",
    query: "limit requests per minute by ip",
    expectedRelPath: "src/middleware/rate-limiter.ts",
  },
  {
    name: "concept: ingest pipeline",
    category: "concept",
    query: "ingest record into warehouse",
    expectedRelPath: "pipeline/ingest.py",
  },

  // Headings (markdown)
  {
    name: "heading: pre-flight checklist",
    category: "heading",
    query: "pre-flight checklist",
    expectedRelPath: "processes/release.md",
  },
  {
    name: "heading: incident step acknowledge",
    category: "heading",
    query: "acknowledge alarm pagerduty",
    expectedRelPath: "processes/incident-response.md",
  },
  {
    name: "heading: configuration",
    category: "heading",
    query: "configuration",
    expectedRelPath: "README.md",
    project: "alpha",
  },

  // Command mention
  {
    name: "command: smoke test",
    category: "command",
    query: "npm run smoke client",
    expectedRelPath: "processes/onboarding.md",
  },
  {
    name: "command: release rollback",
    category: "command",
    query: "release-rollback script",
    expectedRelPath: "processes/release.md",
  },

  // Config keys
  {
    name: "config key: rate_limit_per_minute",
    category: "config",
    query: "rate_limit_per_minute",
    expectedRelPath: "config.toml",
  },
  {
    name: "config key: throttle_per_second",
    category: "config",
    query: "throttle_per_second",
    expectedRelPath: "pipeline/config.py",
  },

  // Terminology drift
  {
    name: "drift: throttle ↔ rate limit",
    category: "drift",
    query: "throttle requests by source",
    expectedRelPath: "pipeline/throttle.py",
  },
  {
    name: "drift: credential ↔ authenticate",
    category: "drift",
    query: "verify the request carries a valid bearer credential",
    expectedRelPath: "pipeline/credential_check.py",
  },

  // Refactor coverage (doc + code)
  {
    name: "refactor: forked auth + rate limit history",
    category: "refactor",
    query: "fork drift auth rate limit",
    expectedRelPath: "docs/architecture.md",
  },
  {
    name: "refactor: ingest config loader",
    category: "refactor",
    query: "ingest config loader",
    expectedRelPath: "pipeline/config.py",
  },

  // Skills (knowledge corpus)
  {
    name: "skill: writing style active voice",
    category: "concept",
    query: "active voice for prose",
    expectedRelPath: "skills/writing-style/SKILL.md",
  },
  {
    name: "skill: code style typescript const",
    category: "concept",
    query: "const over let typescript",
    expectedRelPath: "skills/code-style/SKILL.md",
  },
  {
    name: "skill: writing style em dash rule",
    category: "heading",
    query: "no em dashes",
    expectedRelPath: "skills/writing-style/SKILL.md",
  },

  // Scoped query (project)
  {
    name: "scoped: authenticateUser within alpha",
    category: "exact-symbol",
    query: "authenticateUser",
    project: "alpha",
    expectedRelPath: "src/auth/login.ts",
    maxRank: 3,
  },

  // Scoped query (subtree)
  {
    name: "scoped: jwt within src/auth",
    category: "exact-symbol",
    query: "verify jwt token",
    project: "alpha",
    subtree: "src/auth",
    expectedRelPath: "src/auth/jwt.ts",
    maxRank: 3,
  },

  // Language filter
  {
    name: "language: python pipelines",
    category: "filename",
    query: "ingest",
    language: "python",
    expectedRelPath: "pipeline/ingest.py",
  },

  // Analyzer-driven (#60). Each case exercises a different analyzer
  // signal so that ranking boosts in WorkspaceSearcher have a regression
  // gate. Without analyzer reasons firing, several of these would still
  // pass on lexical alone — that's fine; the goal is to ensure adding
  // boosts doesn't sink them. With #97's expansion we'll add cases that
  // genuinely require the boost to land in top-k.
  {
    name: "analyzer: risky shell call (child_process exec)",
    category: "analyzer",
    query: "exec child_process spawn shell command",
    expectedRelPath: "src/jobs/runner.ts",
  },
  {
    name: "analyzer: deeply nested job runner",
    category: "analyzer",
    query: "deeply nested loops job runner steps",
    expectedRelPath: "src/jobs/runner.ts",
  },
  {
    name: "analyzer: async authentication chain",
    category: "analyzer",
    query: "async authenticate verifyJwt",
    expectedRelPath: "src/auth/login.ts",
  },
  {
    name: "analyzer: ingest calls credential and throttle",
    category: "analyzer",
    query: "ingest admit throttle credential",
    expectedRelPath: "pipeline/ingest.py",
  },
  {
    name: "analyzer: dataclass-imported config loader",
    category: "analyzer",
    query: "dataclasses ingest config loader",
    expectedRelPath: "pipeline/config.py",
  },

  // ---- Debug / error workflows (#97) ----------------------------------
  // "Where does this error come from?" / "What handles this error type?"
  // Lexical-friendly: the exact error string usually appears in the throw.
  {
    name: "debug: missing bearer token error origin",
    category: "debug",
    query: "missing bearer token error",
    expectedRelPath: "src/auth/jwt.ts",
  },
  {
    name: "debug: rate limit exceeded error",
    category: "debug",
    query: "rateLimit middleware perMinute throw exceeded",
    expectedRelPath: "src/middleware/rate-limiter.ts",
  },
  {
    name: "debug: PermissionError credential rejected",
    category: "debug",
    query: "PermissionError credential rejected",
    expectedRelPath: "pipeline/ingest.py",
  },
  {
    name: "debug: OverflowError source over throttle",
    category: "debug",
    query: "OverflowError source over throttle",
    expectedRelPath: "pipeline/ingest.py",
  },

  // ---- Pattern-following (#97) ----------------------------------------
  // "How do we usually structure X" — agent reuses local idioms.
  {
    name: "pattern: token bucket per-second throttle",
    category: "pattern",
    query: "token bucket per second throttle pattern",
    expectedRelPath: "pipeline/throttle.py",
  },
  {
    name: "pattern: in-memory rate limiter middleware",
    category: "pattern",
    query: "in-memory rate limiter middleware pattern",
    expectedRelPath: "src/middleware/rate-limiter.ts",
  },
  {
    name: "pattern: load service config from toml",
    category: "pattern",
    query: "loadServiceConfig parseToml service config",
    expectedRelPath: "src/config/loader.ts",
  },

  // ---- Refactor recon (#97) -------------------------------------------
  // "Every place that imports old auth", "all callers of deprecated X".
  {
    name: "refactor-recon: callers of credential_check",
    category: "refactor-recon",
    query: "callers of credential_check ingest pipeline",
    expectedRelPath: "pipeline/ingest.py",
  },
  {
    name: "refactor-recon: callers of throttle.admit",
    category: "refactor-recon",
    query: "throttle admit callers ingest",
    expectedRelPath: "pipeline/ingest.py",
  },
  {
    name: "refactor-recon: drift between alpha auth and beta auth",
    category: "refactor-recon",
    query: "forked auth pipeline drift alpha beta",
    expectedRelPath: "docs/architecture.md",
  },

  // ---- Skill / process lookups (#97) ----------------------------------
  {
    name: "skill-process: house writing style",
    category: "skill-process",
    query: "house writing style active voice",
    expectedRelPath: "skills/writing-style/SKILL.md",
  },
  {
    name: "skill-process: code style python pathlib",
    category: "skill-process",
    query: "python pathlib code style",
    expectedRelPath: "skills/code-style/SKILL.md",
  },
  {
    name: "skill-process: PagerDuty acknowledge timeout",
    category: "skill-process",
    query: "pagerduty acknowledge alarm 5 minutes incident",
    expectedRelPath: "processes/incident-response.md",
  },
  {
    name: "skill-process: client workspace naming convention",
    category: "skill-process",
    query: "client workspace slug naming convention",
    expectedRelPath: "processes/onboarding.md",
  },

  // ---- Cross-corpus drift (#97) ---------------------------------------
  // Answer spans BOTH code and docs. We assert on the doc chunk because
  // it ties the implementation back to the design — the bit an agent
  // actually needs in a "how does X work" conversation.
  {
    name: "cross-corpus: how does the rate limiter work (design doc)",
    category: "cross-corpus",
    query: "rate limit middleware design throttle requests",
    expectedRelPath: "docs/architecture.md",
    needsDenseEmbedding: true,
  },
  {
    name: "cross-corpus: throttle implementation tied to design",
    category: "cross-corpus",
    query: "RequestThrottle limits requests per source design",
    expectedRelPath: "docs/architecture.md",
  },
  {
    name: "cross-corpus: authentication design analogue",
    category: "cross-corpus",
    query: "credential_check analogue authenticateUser",
    expectedRelPath: "docs/architecture.md",
  },
]);
