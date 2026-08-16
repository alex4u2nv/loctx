/**
 * Lightweight duplicate-code detection (#65).
 *
 * No external dependency — token-window hashing in pure TypeScript.
 * Tokenises file content, slides a window of W tokens, hashes each
 * window. Persisted per-file via the standard enrichment queue. The
 * cross-file collision step lives in the StateStore so we don't pay
 * an N² cost during indexing; aggregation runs on demand when an
 * agent or the CLI asks for duplicate groups.
 *
 * Defaults are conservative (window=50, min unique tokens=15, ignore
 * windows where the same token appears more than half the time) so
 * boilerplate (license headers, repeated imports) doesn't dominate.
 *
 * Out of scope: AST-aware clone detection (PMD CPD, jscpd) — heavier
 * deps, slower runs, marginal payoff for the 'show me likely
 * duplicates' use case loctx targets.
 */

import { createHash } from "node:crypto";

export const DUPLICATES_VERSION = 2; // v2: license-like files skipped

/**
 * License texts are identical across packages by DESIGN — flagging
 * them as duplication is pure noise (they were 800 of 979 findings on
 * loctx's own first report). Matched by basename, any case, with or
 * without an extension.
 */
export function isLicenseLikePath(path: string): boolean {
  const base = path.split(/[\\/]/).at(-1) ?? "";
  return /^(licen[cs]e|notice|copying)(\..*)?$/i.test(base);
}

export interface DuplicateWindow {
  /** Hex-encoded sha1 of the joined token sequence. */
  readonly hash: string;
  /** First file line (1-based, inclusive) covered by the window. */
  readonly startLine: number;
  /** Last file line (1-based, inclusive) covered by the window. */
  readonly endLine: number;
  /** Distinct token count in the window. Used to reject low-signal windows. */
  readonly uniqueTokens: number;
  /** Window length in tokens. Constant per run; carried for convenience. */
  readonly length: number;
}

export interface DuplicatesPayload {
  readonly windows: ReadonlyArray<DuplicateWindow>;
  readonly windowSize: number;
  readonly minUniqueTokens: number;
}

export interface DuplicatesOptions {
  /** Tokens per window. Larger = fewer false positives, more missed clones. */
  readonly windowSize?: number;
  /** Reject windows whose distinct-token count is below this. */
  readonly minUniqueTokens?: number;
  /**
   * Reject windows where the most-frequent token's share exceeds this
   * (e.g. `0.6` rejects windows that are >60% one identifier — usually
   * generated boilerplate or repeated punctuation).
   */
  readonly maxDominantTokenShare?: number;
}

const DEFAULT_OPTS: Required<DuplicatesOptions> = {
  windowSize: 50,
  minUniqueTokens: 15,
  maxDominantTokenShare: 0.6,
};

/**
 * Build window-hash payload for a single file. Pure function — pass the
 * decoded text and a per-token line-number table; no I/O.
 */
export function computeDuplicateWindows(
  content: string,
  opts: DuplicatesOptions = {},
): DuplicatesPayload {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const tokens = tokenize(content);
  const windows: DuplicateWindow[] = [];

  for (let i = 0; i + cfg.windowSize <= tokens.length; i += 1) {
    const slice = tokens.slice(i, i + cfg.windowSize);
    const counts = countTokens(slice.map((t) => t.value));
    const distinct = counts.size;
    if (distinct < cfg.minUniqueTokens) continue;
    const dominant = highestShare(counts, slice.length);
    if (dominant > cfg.maxDominantTokenShare) continue;
    windows.push({
      hash: hashTokens(slice.map((t) => t.value)),
      startLine: slice[0]?.line ?? 1,
      endLine: slice[slice.length - 1]?.line ?? 1,
      uniqueTokens: distinct,
      length: cfg.windowSize,
    });
  }

  return Object.freeze({
    windows: Object.freeze(windows),
    windowSize: cfg.windowSize,
    minUniqueTokens: cfg.minUniqueTokens,
  });
}

interface TokenWithLine {
  readonly value: string;
  readonly line: number;
}

/**
 * Word-shaped tokenizer. Splits on non-identifier characters (Unicode
 * letters/digits + underscore) and tracks the source line per token so
 * each window can report a useful range.
 */
function tokenize(content: string): TokenWithLine[] {
  const out: TokenWithLine[] = [];
  let line = 1;
  let buf = "";
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i] ?? "";
    if (/[\p{L}\p{N}_]/u.test(ch)) {
      buf += ch;
    } else {
      if (buf.length > 0) {
        out.push({ value: buf, line });
        buf = "";
      }
      if (ch === "\n") line += 1;
    }
  }
  if (buf.length > 0) out.push({ value: buf, line });
  return out;
}

function countTokens(tokens: ReadonlyArray<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

function highestShare(counts: ReadonlyMap<string, number>, total: number): number {
  let max = 0;
  for (const v of counts.values()) if (v > max) max = v;
  return total === 0 ? 0 : max / total;
}

function hashTokens(tokens: ReadonlyArray<string>): string {
  return createHash("sha1").update(tokens.join("\x00"), "utf-8").digest("hex");
}
