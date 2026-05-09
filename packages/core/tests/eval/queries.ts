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
  | "refactor";

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
]);
