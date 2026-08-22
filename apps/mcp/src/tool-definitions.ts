/**
 * The MCP tool catalog (#542 split from registry.ts): names, agent-
 * facing descriptions, and input schemas. Dispatch stays in
 * registry.ts; adding a tool means one entry here and one handler +
 * TOOL_HANDLERS row there.
 */

// ---- tool catalog ------------------------------------------------------

export const TOOL_DEFINITIONS = [
  {
    name: "search_workspace",
    description:
      "**Use when the question is conceptual rather than literal**, across any indexed content — code, prose docs, runbooks, agent specs, skill/prompt files, business-process notes. E.g. 'where do we debounce websocket reconnects', 'how is tenant id propagated', 'which skill handles refund escalation', 'how is the vendor-onboarding process documented', 'where is the contract review workflow described'. **Beats `grep`** when no single token captures the question: the vector branch surfaces chunks that contain *no token-level match* — a runbook that *describes* a process without using the user's exact phrasing, a function whose body implements an idea without naming it. Each hit includes the **surrounding chunk** (function body, doc section, list/heading region), so the snippet is usually enough to act without a follow-up `Read`. Pass `coverage: true` for refactor planning ('what else touches X'): top hits are expanded via the symbol cross-ref graph (each expansion carries a `coverageReason`). **Not** the right tool for exhaustive literal-string audits — the lexical branch returns ranked partial-match chunks, not a grep-style file list. For that, use `find_literal`. For exact-symbol cross-references, use `find_usages`. Each result carries `absPath`, `relPath`, `projectName`, line range, score, snippet, `matchReasons`, `analyzer` (AST metadata), `sources` (vector|lexical), and `referencedBy` — the inbound-link count from the doc cross-link graph (#427). Ranking now boosts authoritative source-of-truth docs (high `referencedBy`, `matchReasons: authoritative`) and concept-defining headings (`definition`) while down-weighting derivative slides/catalog files (`derivative`); re-rank on `referencedBy` if you want the canonical doc first. Pass `path` to scope to a project or subtree. Highest-leverage on unfamiliar or large workspaces (code OR docs); on a small set you've already explored, `grep` + `Read` may be faster. `indexHealth.reconciling` signals partial results when a re-index is in flight.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Natural-language or code-fragment query." },
        path: {
          type: "string",
          description:
            "Absolute file or directory path to scope the search. If `path` is a project root, the search is limited to that project. If `path` is inside a project, results are further restricted to that subtree. Omit to search every indexed project.",
        },
        limit: { type: "integer", minimum: 1, default: 10 },
        language: {
          type: "string",
          description: "Filter results to a single language (python, typescript, go, ...).",
        },
        coverage: {
          type: "boolean",
          default: false,
          description:
            "Concept/refactor coverage mode. After the normal ranked list, expand each top hit by following symbol cross-references (callers, importers) and append them with a `coverageReason` explaining why each was included. Use for 'what else touches X' questions before a refactor.",
        },
      },
    },
  },
  {
    name: "workspace_status",
    description:
      "**Pre-flight check before using any other loctx tool. Call once when entering an unfamiliar repo to confirm loctx covers it.** Cheap (in-memory metadata, no scan). If the current repo isn't listed in `projects`, every other loctx tool will return empty for it and you should fall back to `grep`/`find`. If it *is* listed, prefer `find_usages` for symbols, `find_literal` for literal audits, and `search_workspace` for conceptual queries over `grep`. Also returns `indexHealth.reconciling` — when true, a re-index is in flight and other tools may return partial results until it completes. Use `include_indexed_counts: true` to add per-project file counts for a coverage check.",
    inputSchema: {
      type: "object",
      properties: {
        include_indexed_counts: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "find_usages",
    description:
      "**Use when you ask 'where is X used' or 'where is X defined' and X is a symbol name** (function, class, exported identifier). **Beats `grep -rn X`** because each hit is *classified* as `def`|`call`|`import`|`reference` instead of just a text match, and includes the **surrounding chunk** (function body, class body) so you don't need a follow-up `Read` of the file. One call replaces find + grep + several Read calls. **Not** the right tool for file paths or arbitrary literal strings — use `find_literal` for those, or `grep` for safety-critical audits. Each hit carries `relPath`, `line` (exact reference), `chunkStartLine`/`chunkEndLine`, `kind`, and the chunk body. Pass `path` to scope to one project; omit to search every project that knows the symbol. **0-hit semantics:** check `indexHealth.reconciling`. If `true` or `unknown`, the file may not be re-indexed yet (an `unknown` value means a separate daemon owns reconciliation and this server can't see its progress) — retry after the pass, or verify with `workspace_status`. If `false`, either the symbol genuinely isn't defined or this repo isn't indexed (verify with `workspace_status`); don't silently fall back to `grep` on the first 0-hit or you'll lose the signal that the index is the problem. Highest-leverage on unfamiliar or large codebases; for a small repo you've already explored, `grep` may be faster end-to-end.",
    inputSchema: {
      type: "object",
      required: ["symbol"],
      properties: {
        symbol: {
          type: "string",
          description: "Identifier name to look up (function, class, exported variable).",
        },
        path: {
          type: "string",
          description:
            "Absolute or relative path inside the project to scope to. Omit to search every indexed project.",
        },
      },
    },
  },
  {
    name: "find_duplicates",
    description:
      "**Use when you ask 'where do we have duplicated text across files'** — works on any indexed content (code, runbooks, SOP boilerplate, prompt fragments, copy-pasted doc sections). Pre-refactor, when triaging boilerplate, or auditing for accidental copy-paste. **Beats `grep`** because the comparison is on hashed token-windows, not literal text, so it finds duplicates that aren't byte-identical. Heuristic — labelled as such. Requires `analyzers.background_enabled = true` and `analyzers.duplicates.enabled = true` in config; the response's `disabled` field names which knob is off so an empty `groups` from feature-disabled vs. feature-enabled-but-no-hits is distinguishable. Each group: `hash` and `members` (file_id, start/end line range). When `analyzers.duplicates.semantic = true`, the response also carries `semantic`: embedding-based near-duplicate groups ('same meaning, different text') computed at query time over the stored vectors, each with a cosine `similarity` and chunk members; `semanticDisabled` names the knob when off, and a `truncated` flag plus warning appear when the scan cap cut coverage. Cross-project by default — pass `path` to scope to one project, which you should prefer on large workspaces. Output is capped (top groups by size, members per group). Not useful for finding a specific known duplicate — use `find_literal` or `find_usages` for that.",
    inputSchema: {
      type: "object",
      properties: {
        min_members: {
          type: "integer",
          minimum: 2,
          default: 2,
          description: "Minimum file count for a group to surface.",
        },
        path: {
          type: "string",
          description:
            "Absolute path to scope to one project. Omit to scan every indexed project (can be slow + large on big workspaces).",
        },
      },
    },
  },
  {
    name: "quality_report",
    description:
      "**Use when you ask 'what should we refactor / where is the risky or rotting code in this project'** — one ranked view of every quality signal loctx computes. Stored per-file rules (god-file, long-params, deep-nesting, high-fan-out, stale markdown refs) merge with query-time cross-file rules (extract-candidate duplication across 3+ files, high-fan-in blast radius, low-cohesion mixed-concern files, doc-drift for markdown vs the code it cites). Files rank by severity-weighted finding count (error 3, warning 2, info 1). Per-project: pass `path`; defaults to the sole indexed project when only one exists. `rule` filters to one ruleId (e.g. `quality/god-file`); `limit` caps files (default 20, max 100). **Read `report.notes`** — every coverage cap hit is listed there; treat a capped report as partial. Projects can suppress accepted debt via a committed `.loctx-quality.yaml` (rule + path glob + reason) or a `loctx quality baseline` snapshot; suppressed findings are excluded but counted in `report.totals.suppressed` (pass `include_suppressed` to see them). `disabled` names the config knobs when the stored rules haven't run (the cross-file rules run regardless, so the report is partial rather than empty). Heuristic prioritisation for refactoring, not a correctness audit — drill into hits with `find_duplicates`, `find_usages`, or `search_workspace`.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path selecting the project to report on. Optional when exactly one project is indexed.",
        },
        rule: {
          type: "string",
          description: "Only include findings with this exact ruleId (e.g. quality/god-file).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Max files in the report.",
        },
        include_suppressed: {
          type: "boolean",
          default: false,
          description:
            "Also show findings hidden by the project's .loctx-quality.yaml suppressions or its committed baseline (accepted debt). `report.totals.suppressed` counts them either way.",
        },
      },
    },
  },
  {
    name: "find_literal",
    description:
      "**Use when you need every occurrence of a literal substring across the indexed workspace** — code, docs, runbooks, prompts, skill files, anything text. E.g. 'every file referencing agents/foo.md', 'every config still pointing at the old URL', 'every runbook mentioning the deprecated escalation contact', 'every prompt that says \"tier-1\"', 'where is the legacy SKU naming still used'. Returns one row per matched line with `relPath`, `line`, `column`, `lineText`, plus surrounding chunk metadata. **Does NOT beat `grep` for safety-critical audits.** The scan operates on indexed chunk text, so chunker gaps (#360) and excluded-by-default directories (`.git`, `node_modules`, build outputs) are blind spots. Use when an indexed-chunk view is sufficient and you want structured per-line responses with chunk context. The response always includes a `coverageNote` — read it. For audit-critical questions ('is this stale phrase referenced anywhere'), supplement with `rg <pattern>` to verify. Complements `search_workspace` (ranked / semantic) and `find_usages` (exact symbol cross-ref). **0-hit semantics:** check `indexHealth.reconciling`. If `true` or `unknown`, retry after the re-index (an `unknown` value means a separate daemon owns reconciliation and its progress is invisible here). If `false`, the substring either isn't in indexed chunks or this workspace isn't indexed (verify with `workspace_status`). Highest-leverage on unfamiliar or large workspaces; for small sets, `rg` may be faster.",
    inputSchema: {
      type: "object",
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description:
            "Literal substring to find. Plain text — SQL LIKE wildcards (% _ \\) are pre-escaped, so an agent can pass the raw user-facing string without escaping.",
        },
        path: {
          type: "string",
          description:
            "Absolute file or directory path to scope the audit. If a project root, the scan stays inside that project. If a subtree, results are further restricted by relPath prefix. Omit to scan every indexed project.",
        },
      },
    },
  },
  {
    name: "refresh_workspace",
    description:
      "**Use when the user mentions recently changing files and you want loctx to see them before the next search.** Triggers a synchronous reconcile pass that prunes deleted files and re-indexes drift. Slow on a cold workspace; usually unnecessary for routine queries (the watcher catches changes live). Returns per-project indexed/skipped/failed counts. Pass `path` to reindex one project; omit to reindex all. Don't call this just because a previous loctx query returned empty — first check `workspace_status` to confirm coverage, then check `indexHealth.reconciling` on a recent response (a `unknown` value means a separate daemon owns reconciliation and its progress isn't observable here).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to a project root. Omit to reindex all.",
        },
      },
    },
  },
] as const;

/**
 * Privileged admin tool. Only listed + dispatchable when `mcp.admin_enabled`
 * is true in config — kept out of the default catalog so an ordinary MCP
 * client never even sees it. Lets a trusted LLM read/write the daemon config
 * and run maintenance, the same operations the admin web UI exposes.
 */
export const ADMIN_TOOL_DEFINITION = {
  name: "admin_workspace",
  description:
    "**Privileged daemon administration — manage loctx itself via your LLM.** Disabled by default; appears only when `mcp.admin_enabled` is set. Dispatches on `action`:\n" +
    "- `get_config`: return every config setting's effective (merged) value, its default, and the config-file path. Call this first to discover valid keys before `set_config`.\n" +
    '- `set_config`: write a `patch` of dot-path keys → values (e.g. `{"maintenance.compactIntervalHours": 12, "analyzers.duplicates.enabled": true}`), validated against the config schema. On the daemon\'s HTTP endpoint the change hot-reloads live (`reloaded: true`); over stdio it lands on disk and applies on the next restart (`reloaded: false`). Some fields (embedding model, daemon port, retrieval mode, watcher) only take effect after a restart even when reloaded.\n' +
    "- `compact`: merge vector-store fragments + prune old version history to reclaim disk; returns before/after/freed bytes. Refused while a reconcile is in flight.\n" +
    "- `backfill_analyzers`: enqueue analyzer enrichment for already-indexed files missing it (optionally scoped to `targets`); returns how many tasks were enqueued.\n" +
    "This is the management counterpart to the read/search tools — use it to tune settings or run upkeep, not to query content.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["get_config", "set_config", "compact", "backfill_analyzers"],
        description: "Which administrative operation to run.",
      },
      patch: {
        type: "object",
        description:
          'For action=set_config: a map of dot-path config keys to new values (e.g. {"maintenance.compactIntervalHours": 12}). Use get_config to list valid keys + current values.',
      },
      targets: {
        type: "array",
        items: { type: "string" },
        description:
          'For action=backfill_analyzers: analyzer names to scope the backfill to (e.g. ["duplicates"]). Omit for all enabled analyzers.',
      },
    },
  },
} as const;
