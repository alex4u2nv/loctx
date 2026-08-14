/**
 * Unit tests for semantic near-duplicate grouping (#523). Vectors are
 * hand-built unit vectors so cosine similarities are exact and every
 * threshold edge is deterministic.
 */

import { describe, expect, it } from "vitest";
import {
  findSemanticDuplicateGroups,
  type SemanticChunk,
} from "../../src/analyzers/semantic-duplicates.js";

function chunk(
  chunkId: string,
  fileId: string,
  vector: ReadonlyArray<number>,
  startLine = 1,
): SemanticChunk {
  return {
    chunkId,
    fileId,
    relPath: `src/${fileId}.ts`,
    startLine,
    endLine: startLine + 9,
    vector,
  };
}

const OPTS = { threshold: 0.92, truncated: false };

describe("findSemanticDuplicateGroups", () => {
  it("groups identical vectors across two files with similarity 1", async () => {
    const result = await findSemanticDuplicateGroups(
      [chunk("c1", "f1", [1, 0, 0]), chunk("c2", "f2", [1, 0, 0]), chunk("c3", "f3", [0, 1, 0])],
      OPTS,
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.similarity).toBe(1);
    expect(result.groups[0]?.files).toBe(2);
    expect(result.groups[0]?.members.map((m) => m.fileId).sort()).toEqual(["f1", "f2"]);
    expect(result.scanned).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("never pairs chunks of the same file, even at similarity 1", async () => {
    const result = await findSemanticDuplicateGroups(
      [chunk("c1", "f1", [1, 0, 0], 1), chunk("c2", "f1", [1, 0, 0], 50)],
      OPTS,
    );
    expect(result.groups).toEqual([]);
  });

  it("respects the threshold: a pair just below it never groups", async () => {
    // cos(a, b) = 0.6 for these two unit vectors.
    const a = [0.6, 0.8, 0];
    const b = [1, 0, 0];
    const below = await findSemanticDuplicateGroups(
      [chunk("c1", "f1", a), chunk("c2", "f2", b)],
      OPTS,
    );
    expect(below.groups).toEqual([]);
    const loose = await findSemanticDuplicateGroups([chunk("c1", "f1", a), chunk("c2", "f2", b)], {
      threshold: 0.5,
      truncated: false,
    });
    expect(loose.groups).toHaveLength(1);
    expect(loose.groups[0]?.similarity).toBeCloseTo(0.6, 4);
  });

  it("merges transitively-linked chunks into one group", async () => {
    // a~b and b~c above threshold; a~c below. All three should land in
    // one component rather than two overlapping groups.
    const a = [1, 0, 0];
    const b = [0.97, 0.243, 0]; // cos(a,b) ≈ 0.97
    const c = [0.88, 0.475, 0]; // cos(b,c) ≈ 0.969, cos(a,c) ≈ 0.88
    const result = await findSemanticDuplicateGroups(
      [chunk("c1", "f1", a), chunk("c2", "f2", b), chunk("c3", "f3", c)],
      { threshold: 0.95, truncated: false },
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.files).toBe(3);
  });

  it("skips zero-norm and empty vectors instead of crashing", async () => {
    const result = await findSemanticDuplicateGroups(
      [chunk("c1", "f1", [0, 0, 0]), chunk("c2", "f2", []), chunk("c3", "f3", [1, 0, 0])],
      OPTS,
    );
    expect(result.groups).toEqual([]);
    expect(result.scanned).toBe(1);
  });

  it("caps groups and members and sorts by file count then similarity", async () => {
    // Two groups: one spans 3 files, one spans 2. maxGroups 1 keeps the
    // 3-file group.
    const result = await findSemanticDuplicateGroups(
      [
        chunk("a1", "f1", [1, 0, 0]),
        chunk("a2", "f2", [1, 0, 0]),
        chunk("a3", "f3", [1, 0, 0]),
        chunk("b1", "f4", [0, 1, 0]),
        chunk("b2", "f5", [0, 1, 0]),
      ],
      { ...OPTS, maxGroups: 1, maxMembersPerGroup: 2 },
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.files).toBe(3);
    expect(result.groups[0]?.members).toHaveLength(2);
  });

  it("propagates the truncation flag from the scan", async () => {
    const result = await findSemanticDuplicateGroups([chunk("c1", "f1", [1, 0])], {
      threshold: 0.9,
      truncated: true,
    });
    expect(result.truncated).toBe(true);
  });

  it("threshold 100% still groups byte-identical vectors (Float32 clamp)", async () => {
    // Non-axis-aligned so Float32 normalization actually rounds.
    const v = [0.3, 0.4, 0.5, 0.7];
    const result = await findSemanticDuplicateGroups(
      [chunk("c1", "f1", v), chunk("c2", "f2", [...v])],
      { threshold: 1, truncated: false },
    );
    expect(result.groups).toHaveLength(1);
  });

  it("minFiles filters groups spanning fewer distinct files", async () => {
    const result = await findSemanticDuplicateGroups(
      [chunk("c1", "f1", [1, 0, 0]), chunk("c2", "f2", [1, 0, 0])],
      { ...OPTS, minFiles: 3 },
    );
    expect(result.groups).toEqual([]);
  });

  it("capped members sample file-diversely, not in scan order", async () => {
    // Three chunks in f1 followed by one each in f2/f3; scan-order
    // sampling with max 3 would show only f1. Diverse sampling covers
    // all three files.
    const result = await findSemanticDuplicateGroups(
      [
        chunk("a1", "f1", [1, 0, 0], 1),
        chunk("a2", "f1", [1, 0, 0], 20),
        chunk("a3", "f1", [1, 0, 0], 40),
        chunk("b1", "f2", [1, 0, 0]),
        chunk("b2", "f3", [1, 0, 0]),
      ],
      { ...OPTS, maxMembersPerGroup: 3 },
    );
    expect(result.groups).toHaveLength(1);
    const memberFiles = new Set(result.groups[0]?.members.map((m) => m.fileId));
    expect(memberFiles.size).toBe(3);
    expect(result.groups[0]?.files).toBe(3);
  });
});
