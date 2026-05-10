/**
 * Tests for the token-window duplicate detector (#65).
 *
 * Pure-function: hash a sliding window of tokens, reject low-signal
 * windows (boilerplate). Cross-file aggregation is the StateStore's
 * job and is exercised separately in state.test.ts.
 */

import { describe, expect, it } from "vitest";
import { computeDuplicateWindows } from "../../src/analyzers/duplicates.js";

describe("computeDuplicateWindows", () => {
  it("emits a window for content longer than the window size", () => {
    const code = Array.from({ length: 30 }, (_, i) => `function foo${i}() { return ${i}; }`).join(
      "\n",
    );
    const result = computeDuplicateWindows(code, { windowSize: 20, minUniqueTokens: 5 });
    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.windowSize).toBe(20);
  });

  it("emits no window when content is shorter than window size", () => {
    const result = computeDuplicateWindows("function tiny() {}", { windowSize: 50 });
    expect(result.windows).toEqual([]);
  });

  it("rejects windows with too few distinct tokens", () => {
    // 60 occurrences of the same identifier — 1 distinct token only.
    const code = "x ".repeat(60);
    const result = computeDuplicateWindows(code, { windowSize: 50, minUniqueTokens: 15 });
    expect(result.windows).toEqual([]);
  });

  it("rejects windows dominated by a single token", () => {
    // 50 tokens where one identifier is 70% of the content.
    const tokens: string[] = [];
    for (let i = 0; i < 35; i += 1) tokens.push("foo");
    for (let i = 0; i < 15; i += 1) tokens.push(`var${i}`);
    const code = tokens.join(" ");
    const result = computeDuplicateWindows(code, {
      windowSize: 50,
      minUniqueTokens: 10,
      maxDominantTokenShare: 0.5,
    });
    expect(result.windows).toEqual([]);
  });

  it("identical content produces identical hashes (cross-file dedupe contract)", () => {
    const code = Array.from({ length: 60 }, (_, i) => `compute(${i});`).join("\n");
    const a = computeDuplicateWindows(code, { windowSize: 20, minUniqueTokens: 5 });
    const b = computeDuplicateWindows(code, { windowSize: 20, minUniqueTokens: 5 });
    expect(a.windows.map((w) => w.hash)).toEqual(b.windows.map((w) => w.hash));
  });

  it("tracks line numbers per window", () => {
    const code = ["// line 1", ...Array.from({ length: 60 }, (_, i) => `tok${i}`)].join("\n");
    const result = computeDuplicateWindows(code, { windowSize: 20, minUniqueTokens: 5 });
    const first = result.windows[0];
    expect(first?.startLine).toBeGreaterThanOrEqual(1);
    expect(first?.endLine).toBeGreaterThan(first?.startLine ?? 0);
  });
});
