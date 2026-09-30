/**
 * On-disk index size and its per-project attribution (the /projects
 * "1.2 GB · 34% of index" cell). The attribution is a pure split by
 * chunk count; the measurement walks real directories.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attributeIndexBytes, indexSizeBytes, pathSizeBytes } from "../../server/lib/index-size.js";
import { fakeConfig } from "./helpers/harness.js";

describe("attributeIndexBytes", () => {
  it("splits the total in proportion to chunk counts and sums back to it", () => {
    const shares = attributeIndexBytes(
      1_000,
      new Map([
        ["a", 30],
        ["b", 60],
        ["c", 10],
      ]),
    );
    expect(shares.get("a")).toBe(300);
    expect(shares.get("b")).toBe(600);
    expect(shares.get("c")).toBe(100);
  });

  it("gives 0 to chunkless projects and to everyone when nothing is indexed", () => {
    expect(attributeIndexBytes(500, new Map([["a", 0]])).get("a")).toBe(0);
    expect(
      attributeIndexBytes(
        0,
        new Map([
          ["a", 5],
          ["b", 5],
        ]),
      ).get("b"),
    ).toBe(0);
  });

  it("rounds to whole bytes", () => {
    const shares = attributeIndexBytes(
      10,
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    expect(shares.get("a")).toBe(3);
    expect(shares.get("b")).toBe(7);
  });
});

describe("pathSizeBytes / indexSizeBytes", () => {
  it("sums files recursively, treats missing paths as 0, and covers the DB sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "loctx-index-size-"));
    const vectorDir = join(root, "vectors");
    mkdirSync(join(vectorDir, "table.lance"), { recursive: true });
    writeFileSync(join(vectorDir, "table.lance", "frag.bin"), Buffer.alloc(1_024));
    writeFileSync(join(vectorDir, "manifest"), Buffer.alloc(100));
    const stateDb = join(root, "state.sqlite3");
    writeFileSync(stateDb, Buffer.alloc(500));
    writeFileSync(`${stateDb}-wal`, Buffer.alloc(50));
    // no -shm file on purpose: must contribute 0, not throw

    expect(pathSizeBytes(vectorDir)).toBe(1_124);
    expect(pathSizeBytes(join(root, "does-not-exist"))).toBe(0);

    const config = fakeConfig();
    (config.paths as { vectorDir: string }).vectorDir = vectorDir;
    (config.paths as { stateDb: string }).stateDb = stateDb;
    expect(indexSizeBytes(config)).toBe(1_124 + 500 + 50);
  });
});
