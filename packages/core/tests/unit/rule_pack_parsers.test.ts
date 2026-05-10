/**
 * Parser unit tests for the Semgrep + ast-grep rule-pack adapters (#64).
 *
 * The adapters shell out to external binaries we don't want CI to
 * install, so the parsers are exercised directly against fixture JSON
 * captured from real runs (versions 1.x of each tool).
 */

import { describe, expect, it } from "vitest";
import { parseAstGrepJson, parseSemgrepJson } from "../../src/analyzers/index.js";

describe("parseSemgrepJson", () => {
  it("normalises a single result with nested start/end and metadata", () => {
    const out = parseSemgrepJson(
      JSON.stringify({
        version: "1.45.0",
        results: [
          {
            check_id: "python.lang.security.audit.exec-detected",
            path: "app.py",
            start: { line: 12 },
            end: { line: 14 },
            extra: {
              message: "exec() is dangerous",
              severity: "ERROR",
              metadata: { category: "security" },
            },
          },
        ],
      }),
      50,
    );
    expect(out.toolVersion).toBe("1.45.0");
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f?.ruleId).toBe("python.lang.security.audit.exec-detected");
    expect(f?.severity).toBe("error");
    expect(f?.message).toBe("exec() is dangerous");
    expect(f?.category).toBe("security");
    expect(f?.lineFrom).toBe(12);
    expect(f?.lineTo).toBe(14);
  });

  it("tolerates missing extras and unknown severity strings", () => {
    const out = parseSemgrepJson(
      JSON.stringify({
        results: [
          {
            check_id: "x",
            start_line: 3,
            end_line: 3,
          },
        ],
      }),
      50,
    );
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe("info");
    expect(out.findings[0]?.message).toBe("");
    expect(out.findings[0]?.category).toBe("");
  });

  it("drops rows without a usable line range", () => {
    const out = parseSemgrepJson(
      JSON.stringify({
        results: [{ check_id: "skip-me" }, { check_id: "keep-me", start_line: 5, end_line: 5 }],
      }),
      50,
    );
    expect(out.findings.map((f) => f.ruleId)).toEqual(["keep-me"]);
  });

  it("caps findings at maxFindingsPerFile", () => {
    const results = Array.from({ length: 100 }, (_, i) => ({
      check_id: `r-${i}`,
      start_line: 1,
      end_line: 1,
    }));
    const out = parseSemgrepJson(JSON.stringify({ results }), 10);
    expect(out.findings).toHaveLength(10);
    expect(out.findings[0]?.ruleId).toBe("r-0");
    expect(out.findings[9]?.ruleId).toBe("r-9");
  });

  it("returns an empty result for malformed JSON", () => {
    const out = parseSemgrepJson("not json", 50);
    expect(out.findings).toHaveLength(0);
    expect(out.toolVersion).toBe("");
  });
});

describe("parseAstGrepJson", () => {
  it("parses a flat match array and converts 0- to 1-indexed lines", () => {
    const out = parseAstGrepJson(
      JSON.stringify([
        {
          ruleId: "no-eval",
          severity: "warning",
          message: "avoid eval",
          metadata: { category: "security" },
          range: { start: { line: 9 }, end: { line: 9 } },
        },
      ]),
      50,
    );
    expect(out.findings).toHaveLength(1);
    const f = out.findings[0];
    expect(f?.ruleId).toBe("no-eval");
    expect(f?.severity).toBe("warning");
    expect(f?.lineFrom).toBe(10);
    expect(f?.lineTo).toBe(10);
  });

  it("accepts the alternate `matches:` envelope", () => {
    const out = parseAstGrepJson(
      JSON.stringify({
        matches: [
          {
            rule_id: "no-debugger",
            severity: "info",
            range: { start: { line: 0 }, end: { line: 0 } },
          },
        ],
      }),
      50,
    );
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.ruleId).toBe("no-debugger");
    expect(out.findings[0]?.severity).toBe("info");
  });

  it("drops matches without a usable range", () => {
    const out = parseAstGrepJson(
      JSON.stringify([
        { ruleId: "no-range" },
        { ruleId: "ok", range: { start: { line: 1 }, end: { line: 1 } } },
      ]),
      50,
    );
    expect(out.findings.map((f) => f.ruleId)).toEqual(["ok"]);
  });

  it("returns an empty result for malformed JSON", () => {
    const out = parseAstGrepJson("not json", 50);
    expect(out.findings).toHaveLength(0);
  });
});
