/**
 * Shared wire-input contract for the retrieval operations exposed by
 * BOTH transports — the HTTP admin API (`/api/search`, `/api/find-usages`,
 * `/api/find-literal`) and the MCP tools (`search_workspace`,
 * `find_usages`, `find_literal`).
 *
 * Before this module the two transports validated the same fields in
 * two dialects: HTTP 400'd on an out-of-range `limit` while MCP
 * silently clamped it, and the bounds + error strings had already
 * drifted (SRV-5 in docs/audits/2026-08-06-code-quality-review.md).
 * The contract now lives here once; transports only map the thrown
 * error to their wire (HTTP → 400 body, MCP → ToolError). Out-of-range
 * values are REJECTED on both sides — the HTTP behaviour won, because
 * a silent clamp hides caller bugs (an agent asking for `limit: 0`
 * and reading "no results" as an answer).
 *
 * Path CONFINEMENT stays transport-side on purpose: what to do with a
 * path outside `workspace_roots` (403 vs ToolError) is wire policy,
 * and both transports already share `resolveUnderWorkspaceRoots`.
 */

/** Field bounds for the shared retrieval inputs. Exported for tests + docs. */
export const TOOL_INPUT_BOUNDS = {
  /** Search query cap — matches the pre-existing /api/search bound. */
  queryMaxChars: 2048,
  /**
   * Result-count bounds (#344 / #326-era): without the upper bound an
   * agent passing `limit: 1_000_000` could OOM the daemon; the lower
   * bound is 1 so callers can't accidentally request an empty payload
   * and read it as "no results".
   */
  limitMin: 1,
  limitMax: 1000,
  limitDefault: 10,
  languageMaxChars: 32,
  pathMaxChars: 1024,
  symbolMaxChars: 256,
  patternMaxChars: 1024,
} as const;

/** Constructor shape for the transport's wire-error class. */
export type InputErrorCtor = new (message: string) => Error;

export interface SearchToolInput {
  readonly query: string;
  readonly limit: number;
  /** Normalized: absent or empty-after-trim → undefined. */
  readonly language?: string;
  /** True only when the caller passed a literal `true`. */
  readonly coverage: boolean;
  /** Trimmed but NOT confined — confinement is transport policy. */
  readonly path?: string;
}

export interface FindUsagesToolInput {
  readonly symbol: string;
  readonly path?: string;
}

export interface FindLiteralToolInput {
  readonly pattern: string;
  readonly path?: string;
}

/**
 * Parse + bound the `search` operation's input. Field order matches the
 * historical HTTP checks (query, limit, language, coverage, path) so
 * multi-error requests keep reporting the same first failure.
 */
export function parseSearchToolInput(
  data: Record<string, unknown>,
  errorCtor: InputErrorCtor,
): SearchToolInput {
  const b = TOOL_INPUT_BOUNDS;
  const query = requiredString(
    data["query"],
    b.queryMaxChars,
    `query required (non-empty string, ≤ ${b.queryMaxChars} chars)`,
    errorCtor,
  );
  const limit = boundedInt(
    data["limit"],
    { min: b.limitMin, max: b.limitMax, fallback: b.limitDefault },
    `limit must be an integer in [${b.limitMin}, ${b.limitMax}]`,
    errorCtor,
  );
  const language = optionalString(
    data["language"],
    b.languageMaxChars,
    `language must be a string (≤ ${b.languageMaxChars} chars)`,
    errorCtor,
  );
  const coverage = data["coverage"];
  if (coverage !== undefined && typeof coverage !== "boolean") {
    throw new errorCtor("coverage must be a boolean");
  }
  const path = optionalPath(data["path"], errorCtor);
  return {
    query,
    limit,
    coverage: coverage === true,
    ...(language !== undefined ? { language } : {}),
    ...(path !== undefined ? { path } : {}),
  };
}

/** Parse + bound the `find_usages` operation's input. */
export function parseFindUsagesToolInput(
  data: Record<string, unknown>,
  errorCtor: InputErrorCtor,
): FindUsagesToolInput {
  const b = TOOL_INPUT_BOUNDS;
  const symbol = requiredString(
    data["symbol"],
    b.symbolMaxChars,
    `symbol required (non-empty string, ≤ ${b.symbolMaxChars} chars)`,
    errorCtor,
  );
  const path = optionalPath(data["path"], errorCtor);
  return { symbol, ...(path !== undefined ? { path } : {}) };
}

/** Parse + bound the `find_literal` operation's input. */
export function parseFindLiteralToolInput(
  data: Record<string, unknown>,
  errorCtor: InputErrorCtor,
): FindLiteralToolInput {
  const b = TOOL_INPUT_BOUNDS;
  const pattern = requiredString(
    data["pattern"],
    b.patternMaxChars,
    `pattern required (non-empty string, ≤ ${b.patternMaxChars} chars)`,
    errorCtor,
  );
  const path = optionalPath(data["path"], errorCtor);
  return { pattern, ...(path !== undefined ? { path } : {}) };
}

/**
 * The find_literal blind-spot note, surfaced verbatim on every response
 * from both transports. One constant because the two inlined copies had
 * already drifted apart (SRV-9); kept markdown-free because the web UI
 * renders it as plain text.
 */
export const FIND_LITERAL_COVERAGE_NOTE =
  "Scans indexed chunk text only. Blind spots: (1) chunker-gap regions inside indexed files " +
  "(#360 — the gap-fill landed in #362/#364 but doesn't cover 100% of lines); (2) files under " +
  "directories the filtering rules exclude — typically `.git/`, `node_modules/`, build outputs " +
  "(`dist/`, `build/`, `coverage/`), and lockfiles by basename (`package-lock.json`, " +
  "`pnpm-lock.yaml`, `yarn.lock`). Inspect the exact list via `workspace_status` → `exclusions`. " +
  "For safety-critical audits ('is this stale URL referenced anywhere'), cross-check with " +
  "`rg <pattern>`.";

// ---- field primitives --------------------------------------------------

function requiredString(
  raw: unknown,
  maxChars: number,
  message: string,
  errorCtor: InputErrorCtor,
): string {
  if (typeof raw !== "string") throw new errorCtor(message);
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > maxChars) throw new errorCtor(message);
  return trimmed;
}

/** Absent and empty-after-trim both normalize to undefined. */
function optionalString(
  raw: unknown,
  maxChars: number,
  message: string,
  errorCtor: InputErrorCtor,
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new errorCtor(message);
  const trimmed = raw.trim();
  if (trimmed.length > maxChars) throw new errorCtor(message);
  return trimmed === "" ? undefined : trimmed;
}

function optionalPath(raw: unknown, errorCtor: InputErrorCtor): string | undefined {
  const b = TOOL_INPUT_BOUNDS;
  return optionalString(
    raw,
    b.pathMaxChars,
    `path must be a string (≤ ${b.pathMaxChars} chars)`,
    errorCtor,
  );
}

/**
 * Bounded integer. Fractional numbers are truncated before the range
 * check (historical HTTP behaviour); out-of-range REJECTS rather than
 * clamps — see the module doc.
 */
function boundedInt(
  raw: unknown,
  opts: { readonly min: number; readonly max: number; readonly fallback: number },
  message: string,
  errorCtor: InputErrorCtor,
): number {
  if (raw === undefined) return opts.fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new errorCtor(message);
  const n = Math.trunc(raw);
  if (n < opts.min || n > opts.max) throw new errorCtor(message);
  return n;
}
