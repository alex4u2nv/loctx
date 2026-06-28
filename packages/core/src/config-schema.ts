/**
 * Declarative schema for the user-facing layered config (global YAML +
 * project YAML). Drives the admin Config-editor UI (rendering + client-
 * side validation) and the `/api/config/write` endpoint (server-side
 * validation before mutating a YAML file).
 *
 * NOT a replacement for `config.ts`'s `loadConfig` mergers — they
 * remain the runtime source of truth. This file describes the same
 * fields in a form the UI and writer can introspect. Keep the two in
 * sync; tests in `config_schema.test.ts` assert defaults and key names
 * round-trip against `loadConfig`.
 *
 * Fields use both their YAML name (snake_case, what the file holds)
 * and their dot-path track key (camelCase, what `Config.sources`
 * uses). The writer takes a patch keyed by track key + the schema
 * resolves it back to the YAML path.
 */

export type FieldType = "string" | "int" | "bool" | "enum" | "string-array";

export interface FieldSchema {
  /** Dot-path key, matches `Config.sources` keys (e.g. "embedding.model"). */
  readonly key: string;
  /** YAML key segments, last-to-first nesting (e.g. ["embedding","model"]). */
  readonly yamlPath: ReadonlyArray<string>;
  readonly label: string;
  readonly help: string;
  readonly type: FieldType;
  readonly default: unknown;
  readonly enumValues?: ReadonlyArray<string>;
  readonly min?: number;
  readonly max?: number;
}

export interface SectionSchema {
  readonly id: string;
  readonly label: string;
  readonly help: string;
  /** Top-level YAML key for this section (e.g. "embedding"). null = root. */
  readonly yamlSection: string | null;
  readonly fields: ReadonlyArray<FieldSchema>;
}

export const CONFIG_SCHEMA: ReadonlyArray<SectionSchema> = Object.freeze([
  {
    id: "workspace",
    label: "Workspace",
    help: "Roots scanned for projects.",
    yamlSection: null,
    fields: [
      {
        key: "workspaceRoots",
        yamlPath: ["workspace_roots"],
        label: "workspace_roots",
        help: "Top-level directories to scan; each .git child becomes a project. Defaults to cwd.",
        type: "string-array",
        default: [],
      },
    ],
  },
  {
    id: "embedding",
    label: "Embedding",
    help: "Local model used to embed code chunks.",
    yamlSection: "embedding",
    fields: [
      {
        key: "embedding.provider",
        yamlPath: ["embedding", "provider"],
        label: "provider",
        help: "Embedding backend.",
        type: "enum",
        default: "huggingface-transformers",
        enumValues: ["huggingface-transformers"],
      },
      {
        key: "embedding.model",
        yamlPath: ["embedding", "model"],
        label: "model",
        help: "HuggingFace model id.",
        type: "string",
        default: "Xenova/all-MiniLM-L6-v2",
      },
      {
        key: "embedding.normalize",
        yamlPath: ["embedding", "normalize"],
        label: "normalize",
        help: "L2-normalize embedding vectors before storage.",
        type: "bool",
        default: true,
      },
    ],
  },
  {
    id: "watcher",
    label: "Watcher",
    help: "Filesystem-event coalescing.",
    yamlSection: "watcher",
    fields: [
      {
        key: "watcher.debounceMs",
        yamlPath: ["watcher", "debounce_ms"],
        label: "debounce_ms",
        help: "Coalesce repeated events within this many milliseconds.",
        type: "int",
        default: 500,
        min: 0,
        max: 60_000,
      },
    ],
  },
  {
    id: "daemon",
    label: "Daemon",
    help: "HTTP/MCP server endpoint.",
    yamlSection: "daemon",
    fields: [
      {
        key: "daemon.port",
        yamlPath: ["daemon", "port"],
        label: "port",
        help: "Port the admin UI + MCP server bind to.",
        type: "int",
        default: 3000,
        min: 0,
        max: 65_535,
      },
      {
        key: "daemon.hostname",
        yamlPath: ["daemon", "hostname"],
        label: "hostname",
        help: "Bind hostname (use 127.0.0.1 to keep loctx local-only).",
        type: "string",
        default: "127.0.0.1",
      },
    ],
  },
  {
    id: "retrieval",
    label: "Retrieval",
    help: "How search ranks results.",
    yamlSection: "retrieval",
    fields: [
      {
        key: "retrieval.mode",
        yamlPath: ["retrieval", "mode"],
        label: "mode",
        help: "hybrid (vector + lexical fused), vector-only, or lexical-only.",
        type: "enum",
        default: "hybrid",
        enumValues: ["hybrid", "vector", "lexical"],
      },
      {
        key: "retrieval.rrfK",
        yamlPath: ["retrieval", "rrf_k"],
        label: "rrf_k",
        help: "Reciprocal-rank-fusion constant. 60 is the literature default.",
        type: "int",
        default: 60,
        min: 1,
        max: 1000,
      },
    ],
  },
  {
    id: "reconciliation",
    label: "Reconciliation",
    help: "Background drift detection between index and disk.",
    yamlSection: "reconciliation",
    fields: [
      {
        key: "reconciliation.runOnStart",
        yamlPath: ["reconciliation", "run_on_start"],
        label: "run_on_start",
        help: "Reconcile every project once at daemon boot.",
        type: "bool",
        default: true,
      },
      {
        key: "reconciliation.intervalSeconds",
        yamlPath: ["reconciliation", "interval_seconds"],
        label: "interval_seconds",
        help: "Periodic reconcile interval (0 to disable).",
        type: "int",
        default: 600,
        min: 0,
        max: 86_400,
      },
    ],
  },
  {
    id: "maintenance",
    label: "Maintenance",
    help: "Background index upkeep — auto-compaction of the append-only vector store.",
    yamlSection: "maintenance",
    fields: [
      {
        key: "maintenance.compactIntervalHours",
        yamlPath: ["maintenance", "compact_interval_hours"],
        label: "compact_interval_hours",
        help: "Auto-compact the vector store on this cadence to reclaim dead version history (0 to disable; the manual compact button still works).",
        type: "int",
        default: 24,
        min: 0,
        max: 8_760,
      },
    ],
  },
  {
    id: "discovery",
    label: "Discovery",
    help: "How loctx finds projects under a workspace root.",
    yamlSection: "discovery",
    fields: [
      {
        key: "discovery.extraMarkers",
        yamlPath: ["discovery", "extra_markers"],
        label: "extra_markers",
        help: "Extra filenames that mark a project root (in addition to .git).",
        type: "string-array",
        default: [],
      },
      {
        key: "discovery.maxDepth",
        yamlPath: ["discovery", "max_depth"],
        label: "max_depth",
        help: "Max scan depth from each workspace root.",
        type: "int",
        default: 4,
        min: 1,
        max: 16,
      },
    ],
  },
  {
    id: "mcp",
    label: "MCP",
    help: "MCP server behaviour.",
    yamlSection: "mcp",
    fields: [
      {
        key: "mcp.logMaxRows",
        yamlPath: ["mcp", "log_max_rows"],
        label: "log_max_rows",
        help: "Rolling row cap on the MCP request log shown on the Logs page. Oldest rows are trimmed past this count. Set to 0 to disable logging.",
        type: "int",
        default: 200,
        min: 0,
        max: 100_000,
      },
      {
        key: "mcp.adminEnabled",
        yamlPath: ["mcp", "admin_enabled"],
        label: "admin_enabled",
        help: "Expose the admin_workspace MCP tool so a connected LLM can run maintenance (compact, analyzer backfill) and read/write this config. Privileged — leave off unless you trust whatever's on the MCP channel.",
        type: "bool",
        default: false,
      },
    ],
  },
  {
    id: "network",
    label: "Network",
    help: "Outbound network for proxied / TLS-intercepting environments. Applies to the model download and loctx's own updates.",
    yamlSection: "network",
    fields: [
      {
        key: "network.caCert",
        yamlPath: ["network", "ca_cert"],
        label: "ca_cert",
        help: "Path to a root CA cert PEM to trust (your org's / proxy's CA). Fixes 'unable to get local issuer certificate' downloads. Blank = none.",
        type: "string",
        default: "",
      },
      {
        key: "network.proxy",
        yamlPath: ["network", "proxy"],
        label: "proxy",
        help: "HTTP(S) proxy URL for outbound requests (e.g. http://proxy.corp:8080). Blank = direct.",
        type: "string",
        default: "",
      },
      {
        key: "network.strictSsl",
        yamlPath: ["network", "strict_ssl"],
        label: "strict_ssl",
        help: "Leave true. Setting false disables TLS verification entirely (insecure) — prefer ca_cert.",
        type: "bool",
        default: true,
      },
    ],
  },
  {
    id: "analyzers",
    label: "Analyzers",
    help: "Background code-analysis runners.",
    yamlSection: "analyzers",
    fields: [
      {
        key: "analyzers.backgroundEnabled",
        yamlPath: ["analyzers", "background_enabled"],
        label: "background_enabled",
        help: "Master switch for the analyzer queue.",
        type: "bool",
        default: false,
      },
      {
        key: "analyzers.concurrency",
        yamlPath: ["analyzers", "concurrency"],
        label: "concurrency",
        help: "How many analyzer tasks run in parallel.",
        type: "int",
        default: 2,
        min: 1,
        max: 16,
      },
      {
        key: "analyzers.perTaskTimeoutMs",
        yamlPath: ["analyzers", "per_task_timeout_ms"],
        label: "per_task_timeout_ms",
        help: "Per-task wall-clock timeout in milliseconds.",
        type: "int",
        default: 60_000,
        min: 1_000,
        max: 600_000,
      },
    ],
  },
  {
    id: "analyzers.lizard",
    label: "Lizard",
    help: "Cyclomatic-complexity metrics.",
    yamlSection: "analyzers",
    fields: [
      {
        key: "analyzers.lizard.enabled",
        yamlPath: ["analyzers", "lizard", "enabled"],
        label: "enabled",
        help: "Enable lizard runner.",
        type: "bool",
        default: false,
      },
      {
        key: "analyzers.lizard.command",
        yamlPath: ["analyzers", "lizard", "command"],
        label: "command",
        help: "Path to the lizard binary.",
        type: "string",
        default: "lizard",
      },
    ],
  },
  {
    id: "analyzers.duplicates",
    label: "Duplicate detection",
    help: "Token-window dedup.",
    yamlSection: "analyzers",
    fields: [
      {
        key: "analyzers.duplicates.enabled",
        yamlPath: ["analyzers", "duplicates", "enabled"],
        label: "enabled",
        help: "Enable duplicate detector.",
        type: "bool",
        default: false,
      },
      {
        key: "analyzers.duplicates.windowSize",
        yamlPath: ["analyzers", "duplicates", "window_size"],
        label: "window_size",
        help: "Sliding-window size in tokens.",
        type: "int",
        default: 50,
        min: 5,
        max: 1000,
      },
      {
        key: "analyzers.duplicates.minUniqueTokens",
        yamlPath: ["analyzers", "duplicates", "min_unique_tokens"],
        label: "min_unique_tokens",
        help: "Skip windows with fewer unique tokens than this.",
        type: "int",
        default: 15,
        min: 1,
        max: 1000,
      },
    ],
  },
  {
    id: "analyzers.semgrep",
    label: "Semgrep",
    help: "Pattern-based static analysis.",
    yamlSection: "analyzers",
    fields: [
      {
        key: "analyzers.semgrep.enabled",
        yamlPath: ["analyzers", "semgrep", "enabled"],
        label: "enabled",
        help: "Enable semgrep runner.",
        type: "bool",
        default: false,
      },
      {
        key: "analyzers.semgrep.command",
        yamlPath: ["analyzers", "semgrep", "command"],
        label: "command",
        help: "Path to the semgrep binary.",
        type: "string",
        default: "semgrep",
      },
      {
        key: "analyzers.semgrep.ruleDirs",
        yamlPath: ["analyzers", "semgrep", "rule_dirs"],
        label: "rule_dirs",
        help: "Directories of semgrep rules to load. Empty falls back to registry_config.",
        type: "string-array",
        default: [],
      },
      {
        key: "analyzers.semgrep.registryConfig",
        yamlPath: ["analyzers", "semgrep", "registry_config"],
        label: "registry_config",
        help: "Fallback ruleset when rule_dirs is empty — a semgrep registry ref like p/default (curated community pack). Blank disables the fallback. Needs network to fetch.",
        type: "string",
        default: "p/default",
      },
      {
        key: "analyzers.semgrep.maxFindingsPerFile",
        yamlPath: ["analyzers", "semgrep", "max_findings_per_file"],
        label: "max_findings_per_file",
        help: "Cap findings per file to keep noisy rules in check.",
        type: "int",
        default: 50,
        min: 1,
        max: 10_000,
      },
    ],
  },
  {
    id: "analyzers.astGrep",
    label: "ast-grep",
    help: "Tree-sitter pattern matching.",
    yamlSection: "analyzers",
    fields: [
      {
        key: "analyzers.astGrep.enabled",
        yamlPath: ["analyzers", "astGrep", "enabled"],
        label: "enabled",
        help: "Enable ast-grep runner.",
        type: "bool",
        default: false,
      },
      {
        key: "analyzers.astGrep.command",
        yamlPath: ["analyzers", "astGrep", "command"],
        label: "command",
        help: "Path to the ast-grep binary.",
        type: "string",
        default: "ast-grep",
      },
      {
        key: "analyzers.astGrep.ruleDirs",
        yamlPath: ["analyzers", "astGrep", "rule_dirs"],
        label: "rule_dirs",
        help: "Directories of ast-grep rules to load. Empty falls back to bundled_rules.",
        type: "string-array",
        default: [],
      },
      {
        key: "analyzers.astGrep.bundledRules",
        yamlPath: ["analyzers", "astGrep", "bundled_rules"],
        label: "bundled_rules",
        help: "Run loctx's bundled starter ast-grep rules when no rule_dirs are set (ast-grep has no community registry).",
        type: "bool",
        default: true,
      },
      {
        key: "analyzers.astGrep.maxFindingsPerFile",
        yamlPath: ["analyzers", "astGrep", "max_findings_per_file"],
        label: "max_findings_per_file",
        help: "Cap findings per file.",
        type: "int",
        default: 50,
        min: 1,
        max: 10_000,
      },
    ],
  },
  {
    id: "analyzers.definitions",
    label: "Definitions",
    help: "Validate agent/skill/knowledge markdown frontmatter against a schema (OKF v0.1 by default).",
    yamlSection: "analyzers",
    fields: [
      {
        key: "analyzers.definitions.enabled",
        yamlPath: ["analyzers", "definitions", "enabled"],
        label: "enabled",
        help: "Enable the definition validator.",
        type: "bool",
        default: true,
      },
      {
        key: "analyzers.definitions.okfDefault",
        yamlPath: ["analyzers", "definitions", "okf_default"],
        label: "okf_default",
        help: "Apply the bundled Open Knowledge Format (OKF) v0.1 schema.",
        type: "bool",
        default: true,
      },
      {
        key: "analyzers.definitions.globs",
        yamlPath: ["analyzers", "definitions", "globs"],
        label: "globs",
        help: "Project-relative globs selecting which .md files are definitions.",
        type: "string-array",
        default: [],
      },
      {
        key: "analyzers.definitions.schemas",
        yamlPath: ["analyzers", "definitions", "schemas"],
        label: "schemas",
        help: "Extra JSON Schema sources (local paths or GitHub URLs) layered on top of OKF.",
        type: "string-array",
        default: [],
      },
      {
        key: "analyzers.definitions.requireFrontmatter",
        yamlPath: ["analyzers", "definitions", "require_frontmatter"],
        label: "require_frontmatter",
        help: "Flag matched files that have no frontmatter block at all.",
        type: "bool",
        default: false,
      },
      {
        key: "analyzers.definitions.checkLinks",
        yamlPath: ["analyzers", "definitions", "check_links"],
        label: "check_links",
        help: "Flag relative markdown links in definition files that don't resolve to an existing file.",
        type: "bool",
        default: true,
      },
      {
        key: "analyzers.definitions.maxFindingsPerFile",
        yamlPath: ["analyzers", "definitions", "max_findings_per_file"],
        label: "max_findings_per_file",
        help: "Cap findings per file.",
        type: "int",
        default: 50,
        min: 1,
        max: 10_000,
      },
    ],
  },
]);

const FIELDS_BY_KEY: ReadonlyMap<string, FieldSchema> = new Map(
  CONFIG_SCHEMA.flatMap((s) => s.fields.map((f) => [f.key, f] as const)),
);

export function getField(key: string): FieldSchema | undefined {
  return FIELDS_BY_KEY.get(key);
}

export interface ValidationError {
  readonly key: string;
  readonly message: string;
}

/**
 * Validate a patch (dot-path → value) against the schema. Returns
 * `[]` when clean. Used by `/api/config/write` before writing YAML.
 */
export function validatePatch(patch: Record<string, unknown>): ReadonlyArray<ValidationError> {
  const errors: ValidationError[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const f = FIELDS_BY_KEY.get(key);
    if (f === undefined) {
      errors.push({ key, message: `unknown config key '${key}'` });
      continue;
    }
    const err = validateValue(f, value);
    if (err !== null) errors.push({ key, message: err });
  }
  return errors;
}

function validateValue(f: FieldSchema, value: unknown): string | null {
  switch (f.type) {
    case "string":
      if (typeof value !== "string") return `expected string, got ${typeof value}`;
      return null;
    case "enum":
      if (typeof value !== "string") return `expected string, got ${typeof value}`;
      if (f.enumValues && !f.enumValues.includes(value))
        return `must be one of ${f.enumValues.join(", ")}`;
      return null;
    case "bool":
      if (typeof value !== "boolean") return `expected boolean, got ${typeof value}`;
      return null;
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value))
        return `expected integer, got ${typeof value}`;
      if (f.min !== undefined && value < f.min) return `must be ≥ ${f.min}`;
      if (f.max !== undefined && value > f.max) return `must be ≤ ${f.max}`;
      return null;
    case "string-array":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
        return "expected array of strings";
      return null;
  }
}
