import { describe, expect, it } from "vitest";
import {
  bytesToTokens,
  estimateQueryValue,
  isValueTool,
  summarizeUsage,
  toUsageDeltas,
  USAGE_CHARS_PER_TOKEN,
  type UsageStatRow,
} from "../../src/usage.js";

// A file-size lookup: every file is 1000 bytes unless overridden.
const sizes = (over: Record<string, number> = {}) => {
  return (projectId: string, relPath: string): number | null => {
    const key = `${projectId}/${relPath}`;
    return over[key] ?? (relPath.endsWith(".unknown") ? null : 1000);
  };
};

describe("isValueTool", () => {
  it("accepts the file-backed retrieval tools only", () => {
    expect(isValueTool("search_workspace")).toBe(true);
    expect(isValueTool("find_usages")).toBe(true);
    expect(isValueTool("find_literal")).toBe(true);
    expect(isValueTool("workspace_status")).toBe(false);
    expect(isValueTool("find_duplicates")).toBe(false);
    expect(isValueTool("admin_workspace")).toBe(false);
  });
});

describe("estimateQueryValue — search_workspace", () => {
  it("sums baseline over unique files and returned over every snippet", () => {
    const result = {
      results: [
        { projectId: "p1", relPath: "a.ts", snippet: "x".repeat(40) },
        { projectId: "p1", relPath: "a.ts", snippet: "y".repeat(60) }, // same file, 2nd chunk
        { projectId: "p2", relPath: "b.ts", snippet: "z".repeat(10) },
      ],
    };
    const value = estimateQueryValue("search_workspace", result, sizes());
    expect(value.hadResults).toBe(true);

    const p1 = value.byProject.find((p) => p.projectId === "p1");
    const p2 = value.byProject.find((p) => p.projectId === "p2");
    // p1: one unique file (1000 baseline), 40+60 snippet bytes, 1 file.
    expect(p1).toEqual({
      projectId: "p1",
      baselineBytes: 1000,
      returnedBytes: 100,
      filesReferenced: 1,
    });
    expect(p2).toEqual({
      projectId: "p2",
      baselineBytes: 1000,
      returnedBytes: 10,
      filesReferenced: 1,
    });
  });

  it("counts files whose size is unknown as zero baseline", () => {
    const result = { results: [{ projectId: "p1", relPath: "gone.unknown", snippet: "abcd" }] };
    const value = estimateQueryValue("search_workspace", result, sizes());
    expect(value.byProject[0]).toEqual({
      projectId: "p1",
      baselineBytes: 0,
      returnedBytes: 4,
      filesReferenced: 1,
    });
  });
});

describe("estimateQueryValue — find_usages", () => {
  it("walks defs and refs across projects using the document as the snippet", () => {
    const result = {
      projects: [
        {
          projectId: "p1",
          defs: [{ relPath: "def.ts", document: "d".repeat(20) }],
          refs: [{ relPath: "use.ts", document: "u".repeat(30) }],
        },
      ],
    };
    const value = estimateQueryValue("find_usages", result, sizes());
    const p1 = value.byProject.find((p) => p.projectId === "p1");
    expect(p1?.baselineBytes).toBe(2000); // two distinct files
    expect(p1?.returnedBytes).toBe(50);
    expect(p1?.filesReferenced).toBe(2);
  });
});

describe("estimateQueryValue — find_literal", () => {
  it("uses lineText as the returned content", () => {
    const result = {
      matches: [
        { projectId: "p1", relPath: "a.ts", lineText: "const x = 1" },
        { projectId: "p1", relPath: "a.ts", lineText: "const x = 2" },
      ],
    };
    const value = estimateQueryValue("find_literal", result, sizes());
    const p1 = value.byProject[0];
    expect(p1?.filesReferenced).toBe(1);
    expect(p1?.baselineBytes).toBe(1000);
    expect(p1?.returnedBytes).toBe("const x = 1".length + "const x = 2".length);
  });
});

describe("estimateQueryValue — empty / malformed", () => {
  it("reports no results for an empty response", () => {
    const value = estimateQueryValue("search_workspace", { results: [] }, sizes());
    expect(value.hadResults).toBe(false);
    expect(value.byProject).toHaveLength(0);
  });

  it("ignores rows missing projectId or relPath, and non-object results", () => {
    const value = estimateQueryValue(
      "search_workspace",
      { results: [{ projectId: "p1" }, { relPath: "a.ts" }, null, 42] },
      sizes(),
    );
    expect(value.hadResults).toBe(false);
  });

  it("returns an empty value when the response is not an object", () => {
    expect(estimateQueryValue("search_workspace", null, sizes()).hadResults).toBe(false);
    expect(estimateQueryValue("search_workspace", "nope", sizes()).hadResults).toBe(false);
  });
});

describe("toUsageDeltas", () => {
  it("emits a workspace roll-up plus one row per project", () => {
    const value = estimateQueryValue(
      "search_workspace",
      {
        results: [
          { projectId: "p1", relPath: "a.ts", snippet: "abc" },
          { projectId: "p2", relPath: "b.ts", snippet: "de" },
        ],
      },
      sizes(),
    );
    const deltas = toUsageDeltas(value, 12);
    const roll = deltas.find((d) => d.projectId === "");
    expect(roll).toEqual({
      projectId: "",
      queries: 1,
      resultsBytes: 5, // 3 + 2
      baselineBytes: 2000,
      filesReadAvoided: 2,
      zeroHitQueries: 0,
      elapsedMs: 12,
    });
    // Per-project rows carry no elapsed/zero-hit (those live on the roll-up).
    const p1 = deltas.find((d) => d.projectId === "p1");
    expect(p1?.queries).toBe(1);
    expect(p1?.elapsedMs).toBe(0);
    expect(deltas).toHaveLength(3);
  });

  it("records a zero-hit on the roll-up when nothing was returned", () => {
    const value = estimateQueryValue("search_workspace", { results: [] }, sizes());
    const deltas = toUsageDeltas(value, 5);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ projectId: "", queries: 1, zeroHitQueries: 1 });
  });
});

describe("bytesToTokens", () => {
  it("divides by the chars-per-token heuristic", () => {
    expect(bytesToTokens(4000)).toBe(4000 / USAGE_CHARS_PER_TOKEN);
    expect(bytesToTokens(0)).toBe(0);
  });
});

describe("summarizeUsage", () => {
  const row = (over: Partial<UsageStatRow>): UsageStatRow => ({
    projectId: "p",
    queries: 0,
    resultsBytes: 0,
    baselineBytes: 0,
    filesReadAvoided: 0,
    zeroHitQueries: 0,
    elapsedMs: 0,
    ...over,
  });

  it("derives tokens saved, reduction %, zero-hit % and avg latency from the roll-up", () => {
    const rows: UsageStatRow[] = [
      row({
        projectId: "",
        queries: 4,
        baselineBytes: 40_000, // 10_000 tok
        resultsBytes: 4_000, //  1_000 tok
        filesReadAvoided: 9,
        zeroHitQueries: 1,
        elapsedMs: 200,
      }),
    ];
    const { workspace } = summarizeUsage(rows);
    expect(workspace.baselineTokens).toBe(10_000);
    expect(workspace.tokensReturned).toBe(1_000);
    expect(workspace.tokensSaved).toBe(9_000);
    expect(workspace.reductionPct).toBe(90);
    expect(workspace.zeroHitPct).toBe(25);
    expect(workspace.avgLatencyMs).toBe(50);
  });

  it("floors tokensSaved at zero and guards divide-by-zero", () => {
    const { workspace } = summarizeUsage([
      row({ projectId: "", queries: 0, baselineBytes: 0, resultsBytes: 400 }),
    ]);
    expect(workspace.tokensSaved).toBe(0);
    expect(workspace.reductionPct).toBe(0);
    expect(workspace.zeroHitPct).toBe(0);
    expect(workspace.avgLatencyMs).toBe(0);
  });

  it("lists projects sorted by tokens saved, excluding the roll-up row", () => {
    const rows: UsageStatRow[] = [
      row({ projectId: "", baselineBytes: 999_999 }),
      row({ projectId: "small", baselineBytes: 4_000, queries: 1 }),
      row({ projectId: "big", baselineBytes: 40_000, queries: 2 }),
    ];
    const { byProject } = summarizeUsage(rows);
    expect(byProject.map((p) => p.projectId)).toEqual(["big", "small"]);
    expect(byProject[0]?.tokensSaved).toBe(10_000);
  });

  it("returns an all-zero workspace summary when there are no rows", () => {
    const { workspace, byProject } = summarizeUsage([]);
    expect(workspace.queries).toBe(0);
    expect(workspace.tokensSaved).toBe(0);
    expect(byProject).toHaveLength(0);
  });
});
