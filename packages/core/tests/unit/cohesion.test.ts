/**
 * Cohesion scoring tests (#524). Hand-built unit vectors make every
 * centroid and cosine exact.
 */

import { describe, expect, it } from "vitest";
import {
  cohesionFlags,
  computeFileCohesion,
  type FileCohesionScore,
} from "../../src/analyzers/cohesion.js";
import type { SemanticChunk } from "../../src/analyzers/semantic-duplicates.js";

function chunk(fileId: string, relPath: string, vector: ReadonlyArray<number>): SemanticChunk {
  return {
    chunkId: `${fileId}-${Math.abs(vector[0] ?? 0)}-${vector.length}`,
    fileId,
    relPath,
    startLine: 1,
    endLine: 10,
    vector,
  };
}

function file(fileId: string, relPath: string, vectors: ReadonlyArray<ReadonlyArray<number>>) {
  return vectors.map((v) => ({
    ...chunk(fileId, relPath, v),
    chunkId: `${fileId}-${vectors.indexOf(v)}`,
  }));
}

describe("computeFileCohesion", () => {
  it("scores a tight file high and a scattered file low", () => {
    const tight = file("f1", "src/a.ts", [
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);
    const scattered = file("f2", "src/b.ts", [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    const scores = computeFileCohesion([...tight, ...scattered]);
    const s1 = scores.find((s) => s.fileId === "f1");
    const s2 = scores.find((s) => s.fileId === "f2");
    expect(s1?.cohesion).toBeCloseTo(1, 4);
    expect(s2?.cohesion).toBeLessThan(0.7);
    expect(scores[0]?.fileId).toBe("f2"); // sorted ascending
  });

  it("skips files below the chunk floor", () => {
    const scores = computeFileCohesion(
      file("f1", "src/a.ts", [
        [1, 0, 0],
        [0, 1, 0],
      ]),
    );
    expect(scores).toEqual([]);
  });

  it("splits code and prose into separate populations", () => {
    const scores = computeFileCohesion([
      ...file("f1", "src/a.ts", [
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
      ]),
      ...file("f2", "docs/guide.md", [
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
      ]),
    ]);
    expect(scores.find((s) => s.fileId === "f1")?.population).toBe("code");
    expect(scores.find((s) => s.fileId === "f2")?.population).toBe("prose");
  });

  it("skips zero-norm vectors without crashing", () => {
    const scores = computeFileCohesion(
      file("f1", "src/a.ts", [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
      ]),
    );
    // Zero-norm chunk dropped → only 2 usable chunks → below floor.
    expect(scores).toEqual([]);
  });
});

describe("cohesionFlags", () => {
  function score(
    fileId: string,
    cohesion: number,
    population: "code" | "prose" = "code",
  ): FileCohesionScore {
    return { fileId, relPath: `src/${fileId}`, cohesion, chunks: 5, population };
  }

  it("flags the bottom fraction below the ceiling", () => {
    const scores = Array.from({ length: 20 }, (_, i) => score(`f${i}`, 0.3 + i * 0.03));
    const flags = cohesionFlags(scores, { bottomFraction: 0.1, absoluteCeiling: 0.5 });
    expect(flags).toHaveLength(2);
    expect(flags[0]?.finding.ruleId).toBe("quality/low-cohesion");
    expect(flags[0]?.finding.severity).toBe("info");
    expect(flags.map((f) => f.fileId)).toEqual(["f0", "f1"]);
  });

  it("flags nothing in a uniformly cohesive population", () => {
    const scores = Array.from({ length: 20 }, (_, i) => score(`f${i}`, 0.85 + i * 0.005));
    expect(cohesionFlags(scores)).toEqual([]);
  });

  it("scores populations independently — scattered prose does not drag code in", () => {
    const scores = [
      ...Array.from({ length: 10 }, (_, i) => score(`c${i}`, 0.9 + i * 0.005, "code")),
      ...Array.from({ length: 10 }, (_, i) => score(`p${i}`, 0.2 + i * 0.01, "prose")),
    ];
    const flags = cohesionFlags(scores);
    expect(flags.every((f) => f.score.population === "prose")).toBe(true);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]?.finding.message).toContain("document");
  });

  it("small populations flag nothing (floor of the fraction)", () => {
    const scores = Array.from({ length: 5 }, (_, i) => score(`f${i}`, 0.3 + i * 0.01));
    expect(cohesionFlags(scores, { bottomFraction: 0.1 })).toEqual([]);
  });
});
