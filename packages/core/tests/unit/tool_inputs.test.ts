/**
 * tool-inputs.ts — the shared wire-input contract for search /
 * find_usages / find_literal (SRV-5). Both transports (HTTP routes and
 * MCP tools) parse through these functions, so the bounds and error
 * strings asserted here are the single source of truth for both wires.
 * Out-of-range values REJECT on both sides — the silent MCP clamp is
 * gone (see the module doc).
 */

import { describe, expect, it } from "vitest";
import {
  FIND_LITERAL_COVERAGE_NOTE,
  parseFindLiteralToolInput,
  parseFindUsagesToolInput,
  parseSearchToolInput,
  TOOL_INPUT_BOUNDS,
} from "../../src/tool-inputs.js";

class WireError extends Error {}

describe("parseSearchToolInput", () => {
  it("applies defaults: limit 10, coverage false, no language/path", () => {
    const out = parseSearchToolInput({ query: "auth" }, WireError);
    expect(out).toEqual({ query: "auth", limit: TOOL_INPUT_BOUNDS.limitDefault, coverage: false });
  });

  it("trims the query and rejects missing/empty/overlong ones", () => {
    expect(parseSearchToolInput({ query: "  auth  " }, WireError).query).toBe("auth");
    for (const query of [undefined, "", "   ", 7, "x".repeat(2049)]) {
      expect(() => parseSearchToolInput({ query }, WireError)).toThrow(
        "query required (non-empty string, ≤ 2048 chars)",
      );
    }
  });

  it("throws the caller's error class so each transport maps its own wire", () => {
    expect(() => parseSearchToolInput({}, WireError)).toThrow(WireError);
  });

  it("accepts the inclusive limit bounds and truncates fractions", () => {
    expect(parseSearchToolInput({ query: "x", limit: 1 }, WireError).limit).toBe(1);
    expect(parseSearchToolInput({ query: "x", limit: 1000 }, WireError).limit).toBe(1000);
    expect(parseSearchToolInput({ query: "x", limit: 42.9 }, WireError).limit).toBe(42);
  });

  it("REJECTS an out-of-range or non-numeric limit (no silent clamp)", () => {
    for (const limit of [0, 1001, 999_999, -5, "10", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseSearchToolInput({ query: "x", limit }, WireError)).toThrow(
        "limit must be an integer in [1, 1000]",
      );
    }
  });

  it("normalizes an empty language/path to absent; rejects wrong types", () => {
    const out = parseSearchToolInput({ query: "x", language: "  ", path: "" }, WireError);
    expect(out.language).toBeUndefined();
    expect(out.path).toBeUndefined();
    expect(parseSearchToolInput({ query: "x", language: " py " }, WireError).language).toBe("py");
    expect(() => parseSearchToolInput({ query: "x", language: 7 }, WireError)).toThrow(
      "language must be a string (≤ 32 chars)",
    );
    expect(() => parseSearchToolInput({ query: "x", path: 7 }, WireError)).toThrow(
      "path must be a string (≤ 1024 chars)",
    );
    expect(() => parseSearchToolInput({ query: "x", path: "p".repeat(1025) }, WireError)).toThrow(
      "path must be a string (≤ 1024 chars)",
    );
  });

  it("coverage is true only for a literal true; non-booleans reject", () => {
    expect(parseSearchToolInput({ query: "x", coverage: true }, WireError).coverage).toBe(true);
    expect(parseSearchToolInput({ query: "x", coverage: false }, WireError).coverage).toBe(false);
    expect(() => parseSearchToolInput({ query: "x", coverage: "yes" }, WireError)).toThrow(
      "coverage must be a boolean",
    );
  });
});

describe("parseFindUsagesToolInput", () => {
  it("trims the symbol and passes an optional path through untouched by policy", () => {
    const out = parseFindUsagesToolInput({ symbol: " loadConfig ", path: "/ws/a" }, WireError);
    expect(out).toEqual({ symbol: "loadConfig", path: "/ws/a" });
  });

  it("rejects missing/empty/overlong symbols", () => {
    for (const symbol of [undefined, "", "  ", 5, "s".repeat(257)]) {
      expect(() => parseFindUsagesToolInput({ symbol }, WireError)).toThrow(
        "symbol required (non-empty string, ≤ 256 chars)",
      );
    }
  });
});

describe("parseFindLiteralToolInput", () => {
  it("accepts a pattern up to the cap and normalizes an absent path", () => {
    const pattern = "p".repeat(TOOL_INPUT_BOUNDS.patternMaxChars);
    expect(parseFindLiteralToolInput({ pattern }, WireError)).toEqual({ pattern });
  });

  it("rejects missing/empty/overlong patterns", () => {
    for (const pattern of [undefined, "", "  ", 5, "x".repeat(1025)]) {
      expect(() => parseFindLiteralToolInput({ pattern }, WireError)).toThrow(
        "pattern required (non-empty string, ≤ 1024 chars)",
      );
    }
  });
});

describe("FIND_LITERAL_COVERAGE_NOTE", () => {
  it("names the chunker-gap blind spot and the rg cross-check", () => {
    expect(FIND_LITERAL_COVERAGE_NOTE).toContain("#360");
    expect(FIND_LITERAL_COVERAGE_NOTE).toContain("rg <pattern>");
    expect(FIND_LITERAL_COVERAGE_NOTE).toContain("workspace_status");
  });

  it("stays markdown-free (the web UI renders it as plain text)", () => {
    expect(FIND_LITERAL_COVERAGE_NOTE).not.toContain("**");
  });
});
