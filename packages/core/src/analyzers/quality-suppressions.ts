/**
 * Per-project quality suppressions + baseline (#566).
 *
 * Two committed, data-only files at the project root put calibration
 * in the user's hands without forking rule config or waiting on
 * upstream releases:
 *
 *   - `.loctx-quality.yaml` — explicit suppressions: rule + path glob
 *     + REQUIRED reason (the disabled-with-reason convention).
 *   - `.loctx-quality-baseline.json` — accepted-debt snapshot written
 *     by `loctx quality baseline`; reports then surface only NEW
 *     findings by default (the ratchet pattern: start where you are,
 *     only get better).
 *
 * Suppressed findings stay in storage; the report excludes them from
 *  rollups and totals but always states the suppressed count — a
 * silent cap would read as "clean" when it isn't (house rule: no
 * silent caps). Entries are pure data (rule id + glob + prose), so
 * honoring them from a project-committed file carries no executable
 * surface.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";

export const SUPPRESSIONS_FILE = ".loctx-quality.yaml";
export const BASELINE_FILE = ".loctx-quality-baseline.json";

export interface QualitySuppression {
  /** Exact ruleId (e.g. `quality/god-file`) or `*` for any rule. */
  readonly rule: string;
  /** Project-relative path glob (picomatch, dot files included). */
  readonly path: string;
  /** Why this is accepted — required, so debt stays explainable. */
  readonly reason: string;
}

export interface QualityBaseline {
  readonly version: 1;
  readonly generatedAt: string;
  readonly entries: ReadonlyArray<{ readonly rule: string; readonly path: string }>;
}

/** Everything the report needs, plus loader problems for its notes. */
export interface SuppressionState {
  readonly suppressions: ReadonlyArray<QualitySuppression>;
  /** Keys from {@link baselineKey} for O(1) membership tests. */
  readonly baseline: ReadonlySet<string>;
  /** Malformed entries/files — surfaced as report notes, never fatal. */
  readonly problems: ReadonlyArray<string>;
}

export function baselineKey(rule: string, relPath: string): string {
  return `${rule}\0${relPath}`;
}

/** Parse `.loctx-quality.yaml` content. Invalid entries become problems. */
export function parseSuppressions(content: string): {
  suppressions: QualitySuppression[];
  problems: string[];
} {
  const suppressions: QualitySuppression[] = [];
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    return {
      suppressions,
      problems: [`${SUPPRESSIONS_FILE}: unparseable (${(err as Error).message})`],
    };
  }
  const list = (parsed as { suppressions?: unknown })?.suppressions;
  if (list === undefined || list === null) return { suppressions, problems };
  if (!Array.isArray(list)) {
    return { suppressions, problems: [`${SUPPRESSIONS_FILE}: 'suppressions' must be a list`] };
  }
  list.forEach((entry, i) => {
    const e = entry as Partial<Record<"rule" | "path" | "reason", unknown>> | null;
    const rule = typeof e?.rule === "string" && e.rule !== "" ? e.rule : null;
    const path = typeof e?.path === "string" && e.path !== "" ? e.path : null;
    const reason = typeof e?.reason === "string" && e.reason.trim() !== "" ? e.reason : null;
    if (rule === null || path === null) {
      problems.push(
        `${SUPPRESSIONS_FILE}: entry ${i + 1} needs string 'rule' and 'path' — skipped`,
      );
      return;
    }
    if (reason === null) {
      // Reason is the contract: debt without a why rots. Skip loudly.
      problems.push(
        `${SUPPRESSIONS_FILE}: entry ${i + 1} (${rule} @ ${path}) has no 'reason' — skipped`,
      );
      return;
    }
    suppressions.push(Object.freeze({ rule, path, reason }));
  });
  return { suppressions, problems };
}

/** Parse `.loctx-quality-baseline.json` content into membership keys. */
export function parseBaseline(content: string): { baseline: Set<string>; problems: string[] } {
  try {
    const parsed = JSON.parse(content) as Partial<QualityBaseline>;
    if (!Array.isArray(parsed.entries)) {
      return { baseline: new Set(), problems: [`${BASELINE_FILE}: missing 'entries' list`] };
    }
    const baseline = new Set<string>();
    for (const e of parsed.entries) {
      if (typeof e?.rule === "string" && typeof e?.path === "string") {
        baseline.add(baselineKey(e.rule, e.path));
      }
    }
    return { baseline, problems: [] };
  } catch (err) {
    return {
      baseline: new Set(),
      problems: [`${BASELINE_FILE}: unparseable (${(err as Error).message})`],
    };
  }
}

/** Read both files from the project root (either may be absent). */
export function loadSuppressionState(projectRoot: string): SuppressionState {
  const problems: string[] = [];
  let suppressions: QualitySuppression[] = [];
  let baseline: Set<string> = new Set();
  const supPath = join(projectRoot, SUPPRESSIONS_FILE);
  if (existsSync(supPath)) {
    const parsed = parseSuppressions(readFileSync(supPath, "utf-8"));
    suppressions = parsed.suppressions;
    problems.push(...parsed.problems);
  }
  const basePath = join(projectRoot, BASELINE_FILE);
  if (existsSync(basePath)) {
    const parsed = parseBaseline(readFileSync(basePath, "utf-8"));
    baseline = parsed.baseline;
    problems.push(...parsed.problems);
  }
  return Object.freeze({
    suppressions: Object.freeze(suppressions),
    baseline,
    problems: Object.freeze(problems),
  });
}

export type SuppressionVerdict = "rule" | "baseline" | null;

/**
 * Compile the state into a matcher: why is (ruleId, relPath)
 * suppressed, or null when it isn't. Explicit suppressions win over
 * the baseline in the verdict (they carry a reason).
 */
export function buildSuppressionMatcher(
  state: Pick<SuppressionState, "suppressions" | "baseline">,
): (ruleId: string, relPath: string) => SuppressionVerdict {
  const compiled = state.suppressions.map((s) => ({
    rule: s.rule,
    match: picomatch(s.path, { dot: true }),
  }));
  return (ruleId, relPath) => {
    for (const c of compiled) {
      if ((c.rule === "*" || c.rule === ruleId) && c.match(relPath)) return "rule";
    }
    return state.baseline.has(baselineKey(ruleId, relPath)) ? "baseline" : null;
  };
}

/** Stable serialized baseline: sorted, deduped, versioned. */
export function serializeBaseline(
  entries: Iterable<{ readonly rule: string; readonly path: string }>,
  generatedAt: string,
): string {
  const seen = new Set<string>();
  const unique: Array<{ rule: string; path: string }> = [];
  for (const e of entries) {
    const key = baselineKey(e.rule, e.path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ rule: e.rule, path: e.path });
  }
  unique.sort((a, b) =>
    a.path !== b.path ? a.path.localeCompare(b.path) : a.rule.localeCompare(b.rule),
  );
  const doc: QualityBaseline = { version: 1, generatedAt, entries: unique };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
