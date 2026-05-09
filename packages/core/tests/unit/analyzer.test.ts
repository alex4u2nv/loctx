import { describe, expect, it } from "vitest";
import {
  type AnalyzerMetadata,
  analyzerMetadataFromJson,
  analyzerMetadataToJson,
} from "../../src/models.js";

describe("AnalyzerMetadata serialization", () => {
  const sample: AnalyzerMetadata = Object.freeze({
    imports: Object.freeze(["./auth", "node:path"]),
    exports: Object.freeze(["authenticateUser"]),
    calls: Object.freeze(["verifyJwt", "throw"]),
    maxNestingDepth: 3,
    maxLoopDepth: 1,
    paramCount: 2,
    hasAsync: true,
    hasRecursionHint: false,
    riskyCalls: Object.freeze([]),
    analysisSource: "tree-sitter",
    analysisVersion: 1,
  });

  it("round-trips through JSON without losing fields", () => {
    const json = analyzerMetadataToJson(sample);
    const parsed = analyzerMetadataFromJson(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.imports).toEqual(["./auth", "node:path"]);
    expect(parsed?.maxNestingDepth).toBe(3);
    expect(parsed?.hasAsync).toBe(true);
    expect(parsed?.analysisVersion).toBe(1);
  });

  it("returns null for null/empty input", () => {
    expect(analyzerMetadataFromJson(null)).toBeNull();
    expect(analyzerMetadataFromJson("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(analyzerMetadataFromJson("{not json")).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    // Missing analysisSource / analysisVersion — caller should treat as
    // 'pending re-extraction' the same as a v2-era chunk with NULL metadata.
    expect(analyzerMetadataFromJson(JSON.stringify({ imports: [], calls: [] }))).toBeNull();
  });

  it("fills missing optional fields with safe defaults", () => {
    const minimal = analyzerMetadataFromJson(
      JSON.stringify({ analysisSource: "tree-sitter", analysisVersion: 1 }),
    );
    expect(minimal).not.toBeNull();
    expect(minimal?.imports).toEqual([]);
    expect(minimal?.maxNestingDepth).toBe(0);
    expect(minimal?.hasAsync).toBe(false);
    expect(minimal?.riskyCalls).toEqual([]);
  });
});
