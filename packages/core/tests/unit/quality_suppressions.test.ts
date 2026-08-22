/**
 * Suppression + baseline parsing/matching (#566): reason required,
 * glob semantics, baseline keys, stable serialization.
 */

import { describe, expect, it } from "vitest";
import {
  baselineKey,
  buildSuppressionMatcher,
  parseBaseline,
  parseSuppressions,
  serializeBaseline,
} from "../../src/analyzers/quality-suppressions.js";

describe("parseSuppressions", () => {
  it("accepts complete entries", () => {
    const { suppressions, problems } = parseSuppressions(
      [
        "suppressions:",
        "  - rule: quality/god-file",
        '    path: "src/legacy/**"',
        "    reason: scheduled rewrite",
      ].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(suppressions).toEqual([
      { rule: "quality/god-file", path: "src/legacy/**", reason: "scheduled rewrite" },
    ]);
  });

  it("skips entries without a reason, loudly", () => {
    const { suppressions, problems } = parseSuppressions(
      ["suppressions:", "  - rule: quality/god-file", '    path: "src/**"'].join("\n"),
    );
    expect(suppressions).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no 'reason'");
  });

  it("skips entries missing rule or path, loudly", () => {
    const { suppressions, problems } = parseSuppressions(
      ["suppressions:", "  - reason: why not"].join("\n"),
    );
    expect(suppressions).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  it("unparseable YAML is a problem, not a throw", () => {
    const { suppressions, problems } = parseSuppressions("suppressions: [unclosed");
    expect(suppressions).toEqual([]);
    expect(problems[0]).toContain("unparseable");
  });

  it("an empty or suppression-less file is fine", () => {
    expect(parseSuppressions("").problems).toEqual([]);
    expect(parseSuppressions("other: 1").suppressions).toEqual([]);
  });
});

describe("parseBaseline", () => {
  it("round-trips through serializeBaseline", () => {
    const serialized = serializeBaseline(
      [
        { rule: "quality/god-file", path: "src/b.ts" },
        { rule: "quality/god-file", path: "src/a.ts" },
        { rule: "quality/god-file", path: "src/a.ts" }, // dup dropped
      ],
      "2026-08-22T00:00:00.000Z",
    );
    const { baseline, problems } = parseBaseline(serialized);
    expect(problems).toEqual([]);
    expect(baseline).toEqual(
      new Set([
        baselineKey("quality/god-file", "src/a.ts"),
        baselineKey("quality/god-file", "src/b.ts"),
      ]),
    );
    // Stable: sorted by path, deduped.
    const doc = JSON.parse(serialized) as { entries: unknown[] };
    expect(doc.entries).toEqual([
      { rule: "quality/god-file", path: "src/a.ts" },
      { rule: "quality/god-file", path: "src/b.ts" },
    ]);
  });

  it("reports unparseable or shapeless content as a problem", () => {
    expect(parseBaseline("not json").problems).toHaveLength(1);
    expect(parseBaseline("{}").problems[0]).toContain("entries");
  });
});

describe("buildSuppressionMatcher", () => {
  it("matches exact rule + path glob, including dotfiles", () => {
    const verdict = buildSuppressionMatcher({
      suppressions: [{ rule: "quality/god-file", path: "src/legacy/**", reason: "r" }],
      baseline: new Set(),
    });
    expect(verdict("quality/god-file", "src/legacy/deep/x.ts")).toBe("rule");
    expect(verdict("quality/god-file", "src/legacy/.hidden/x.ts")).toBe("rule");
    expect(verdict("quality/god-file", "src/other/x.ts")).toBeNull();
    expect(verdict("quality/deep-nesting", "src/legacy/deep/x.ts")).toBeNull();
  });

  it("rule '*' suppresses any rule on the matched path", () => {
    const verdict = buildSuppressionMatcher({
      suppressions: [{ rule: "*", path: "vendored/**", reason: "third-party" }],
      baseline: new Set(),
    });
    expect(verdict("quality/god-file", "vendored/lib.ts")).toBe("rule");
    expect(verdict("quality/low-cohesion", "vendored/lib.ts")).toBe("rule");
  });

  it("falls back to baseline membership; explicit rule wins the verdict", () => {
    const verdict = buildSuppressionMatcher({
      suppressions: [{ rule: "quality/god-file", path: "src/a.ts", reason: "r" }],
      baseline: new Set([
        baselineKey("quality/god-file", "src/a.ts"),
        baselineKey("quality/deep-nesting", "src/b.ts"),
      ]),
    });
    expect(verdict("quality/god-file", "src/a.ts")).toBe("rule");
    expect(verdict("quality/deep-nesting", "src/b.ts")).toBe("baseline");
    expect(verdict("quality/deep-nesting", "src/c.ts")).toBeNull();
  });
});
