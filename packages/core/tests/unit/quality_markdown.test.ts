/**
 * Markdown context-quality rules (#527): extraction, resolution against
 * both bases, stale-ref, and doc-drift — all with injected exists/vector
 * data so no filesystem or vector store is involved.
 */

import { describe, expect, it } from "vitest";
import {
  docDriftFinding,
  extractPathRefs,
  isMarkdownPath,
  resolvePathRefs,
  staleRefFindings,
} from "../../src/analyzers/quality-markdown.js";

describe("extractPathRefs", () => {
  it("collects markdown link targets and backticked paths with line numbers", () => {
    const content = [
      "# Doc",
      "See [the indexer](../indexing/indexer.ts) for details.",
      "The entry point is `packages/core/src/container.ts` today.",
      "Visit [docs](https://example.com/docs) or [top](#anchor).",
      "Run `pnpm run verify` before pushing.",
    ].join("\n");
    const refs = extractPathRefs(content);
    expect(refs).toEqual([
      { raw: "../indexing/indexer.ts", line: 2 },
      { raw: "packages/core/src/container.ts", line: 3 },
    ]);
  });

  it("rejects backticked non-paths: no slash, spaces, globs, no extension", () => {
    const content = [
      "`justAnIdentifier` and `two words/like this.ts`",
      "`src/**/*.ts` and `packages/core` and `a/b`",
    ].join("\n");
    expect(extractPathRefs(content)).toEqual([]);
  });

  it("dedupes an identical ref on the same line", () => {
    const refs = extractPathRefs("`a/b.ts` then `a/b.ts` again");
    expect(refs).toHaveLength(1);
  });
});

describe("resolvePathRefs + staleRefFindings", () => {
  const docDir = "/proj/docs";
  const root = "/proj";

  it("resolves against the doc dir first, then the project root", () => {
    const exists = (p: string): boolean => p === "/proj/packages/core/src/a.ts";
    const resolved = resolvePathRefs(
      [{ raw: "packages/core/src/a.ts", line: 3 }],
      docDir,
      root,
      exists,
    );
    expect(resolved[0]?.absPath).toBe("/proj/packages/core/src/a.ts");
    expect(staleRefFindings(resolved)).toEqual([]);
  });

  it("flags a reference that resolves under neither base", () => {
    const resolved = resolvePathRefs([{ raw: "gone/away.ts", line: 7 }], docDir, root, () => false);
    const findings = staleRefFindings(resolved);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe("quality/stale-ref");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.lineFrom).toBe(7);
    expect(findings[0]?.message).toContain("gone/away.ts");
  });

  it("skips home-relative refs and refs escaping the project root", () => {
    const resolved = resolvePathRefs(
      [
        { raw: "~/rules/x.yml", line: 1 },
        { raw: "../../outside/elsewhere.ts", line: 2 },
      ],
      docDir,
      root,
      () => false,
    );
    // ~ ref dropped entirely; escaping ref resolves nowhere in-project
    // and is reported stale only if it stayed inside the root — it
    // didn't, so nothing fires.
    expect(staleRefFindings(resolved.filter((r) => r.absPath === null))).toHaveLength(1);
    expect(resolved).toHaveLength(1);
  });
});

describe("docDriftFinding", () => {
  const unit = (x: number, y: number): Float32Array => {
    const n = Math.sqrt(x * x + y * y);
    return new Float32Array([x / n, y / n]);
  };

  it("fires below the floor with the similarity in the message", () => {
    const finding = docDriftFinding([unit(1, 0)], [unit(0, 1)], 0.35);
    expect(finding?.ruleId).toBe("quality/doc-drift");
    expect(finding?.severity).toBe("info");
    expect(finding?.message).toContain("may have drifted");
  });

  it("stays silent at or above the floor", () => {
    expect(docDriftFinding([unit(1, 0)], [unit(1, 0.2)], 0.35)).toBeNull();
  });

  it("skips cleanly when either side has no vectors", () => {
    expect(docDriftFinding([], [unit(1, 0)], 0.35)).toBeNull();
    expect(docDriftFinding([unit(1, 0)], [], 0.35)).toBeNull();
  });

  it("pools multiple vectors into centroids", () => {
    // Doc centroid ≈ (0.71, 0.71); refs pooled around the same direction.
    const finding = docDriftFinding([unit(1, 0), unit(0, 1)], [unit(1, 1), unit(0.9, 1.1)], 0.9);
    expect(finding).toBeNull();
  });
});

describe("isMarkdownPath", () => {
  it("matches md variants case-insensitively, nothing else", () => {
    expect(isMarkdownPath("/a/README.md")).toBe(true);
    expect(isMarkdownPath("/a/notes.MDX")).toBe(true);
    expect(isMarkdownPath("/a/doc.markdown")).toBe(true);
    expect(isMarkdownPath("/a/code.ts")).toBe(false);
    expect(isMarkdownPath("/a/mdfile.txt")).toBe(false);
  });
});
