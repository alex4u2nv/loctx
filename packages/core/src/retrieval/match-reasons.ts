/**
 * Analyzer-driven match reasons + ranking boosts (#542 split from
 * searcher.ts): query-term analysis against per-chunk AST metadata.
 */

import { RISKY_CATEGORY_TOKENS } from "../chunking/analyzer.js";
import type { AnalyzerMetadata } from "../models.js";
import type { MatchReason } from "./searcher.js";

// ---- analyzer-driven match reasons + boosts ---------------------------

/** Words that signal "the user is asking about complexity / nesting". */
export const COMPLEXITY_QUERY_WORDS = new Set([
  "complex",
  "complexity",
  "deep",
  "deeply",
  "nested",
  "nesting",
  "recursive",
  "recursion",
]);
/** Thresholds beyond which a chunk counts as "high complexity". */
export const HIGH_NESTING_DEPTH = 4;
export const HIGH_LOOP_DEPTH = 2;
export const HIGH_PARAM_COUNT = 5;

// Risky-call category names come from the chunker's analyzer module
// so extract-time + query-time read the same list. Importing rather
// than redeclaring eliminates the previous drift risk (#277).
// `RISKY_CATEGORY_TOKENS` is imported below from "../chunking/analyzer.js".

export interface QueryTerms {
  readonly tokens: ReadonlySet<string>;
  readonly raw: string;
  readonly mentionsAsync: boolean;
  readonly mentionsComplexity: boolean;
  readonly riskyMentions: ReadonlySet<string>;
}

export function analyzerQueryTerms(rawQuery: string): QueryTerms {
  const lower = rawQuery.toLowerCase();
  const tokens = new Set(lower.split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length >= 2));
  const riskyMentions = new Set<string>();
  for (const cat of RISKY_CATEGORY_TOKENS) {
    if (lower.includes(cat)) riskyMentions.add(cat);
  }
  let mentionsComplexity = false;
  for (const w of COMPLEXITY_QUERY_WORDS) {
    if (tokens.has(w)) {
      mentionsComplexity = true;
      break;
    }
  }
  return {
    tokens,
    raw: lower,
    mentionsAsync: tokens.has("async") || tokens.has("await"),
    mentionsComplexity,
    riskyMentions,
  };
}

export function computeMatchReasons(
  meta: AnalyzerMetadata | null,
  q: QueryTerms,
): ReadonlyArray<MatchReason> {
  if (meta === null) return Object.freeze([]);
  const reasons = new Set<MatchReason>();

  // Symbol / export match: any exported name appears as a query token.
  for (const exp of meta.exports) {
    if (q.tokens.has(exp.toLowerCase())) {
      reasons.add("symbol_match");
      reasons.add("exported");
      break;
    }
  }

  // Import match: any imported module/path token appears in the query.
  for (const imp of meta.imports) {
    const lower = imp.toLowerCase();
    if (q.tokens.has(lower)) {
      reasons.add("import_match");
      break;
    }
    // Path-style imports: "./auth/jwt" → match if "jwt" or "auth" in query.
    for (const part of lower.split(/[\\/.]+/u)) {
      if (part.length >= 2 && q.tokens.has(part)) {
        reasons.add("import_match");
        break;
      }
    }
    if (reasons.has("import_match")) break;
  }

  // Call match: an identifier this chunk calls is a query token.
  for (const call of meta.calls) {
    if (q.tokens.has(call.toLowerCase())) {
      reasons.add("call_match");
      break;
    }
  }

  // Risky call: query named a category, chunk uses it.
  if (q.riskyMentions.size > 0 && meta.riskyCalls.length > 0) {
    for (const r of meta.riskyCalls) {
      if (q.riskyMentions.has(r.toLowerCase())) {
        reasons.add("risky_call_category");
        break;
      }
    }
  }

  // Complexity signal: query asked, chunk qualifies.
  if (q.mentionsComplexity) {
    if (
      meta.maxNestingDepth >= HIGH_NESTING_DEPTH ||
      meta.maxLoopDepth >= HIGH_LOOP_DEPTH ||
      meta.paramCount >= HIGH_PARAM_COUNT ||
      meta.hasRecursionHint
    ) {
      reasons.add("complexity_signal");
    }
  }

  // Async match.
  if (q.mentionsAsync && meta.hasAsync) reasons.add("async_match");

  return Object.freeze([...reasons]);
}

/**
 * Build a SearchResult from whichever branch(es) returned this chunk.
 * Vector matches carry richer metadata (language is stored, snippet is
 * the embedded document); lexical matches carry start/end_line + kind
 * via the JOIN to chunks. Either is enough on its own.
 */
