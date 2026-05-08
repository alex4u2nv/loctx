import { describe, expect, it } from "vitest";
import {
  LANGUAGE_BY_EXTENSION,
  LineWindowChunker,
  chunkFile,
  chunkShaFor,
  detectLanguage,
} from "../../src/chunking/index.js";

describe("detectLanguage", () => {
  it.each([
    ["foo.py", "python"],
    ["src/Foo.tsx", "tsx"],
    ["a/b.go", "go"],
    ["README", null],
    ["data.json", null],
    ["nested/path/script.JS", "javascript"],
  ])("%s -> %s", (path, expected) => {
    expect(detectLanguage(path)).toBe(expected);
  });

  it("registered extensions are lowercase", () => {
    expect(Object.keys(LANGUAGE_BY_EXTENSION).every((e) => e === e.toLowerCase())).toBe(true);
  });
});

describe("LineWindowChunker", () => {
  it("yields overlapping chunks", () => {
    const content = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n");
    const chunks = new LineWindowChunker({ windowLines: 60, overlapLines: 10 }).chunk({
      relPath: "big.txt",
      content,
      language: null,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(60);
    expect(chunks[1]?.startLine).toBe(51);
    expect(chunks.every((c) => c.kind === "window")).toBe(true);
  });

  it("handles short files", () => {
    const chunks = new LineWindowChunker().chunk({
      relPath: "small.txt",
      content: "one\ntwo\nthree",
      language: null,
    });
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(3);
  });

  it("returns no chunks for empty content", () => {
    const chunks = new LineWindowChunker().chunk({ relPath: "x", content: "", language: null });
    expect(chunks).toEqual([]);
  });

  it("validates options", () => {
    expect(() => new LineWindowChunker({ windowLines: 0 })).toThrow();
    expect(() => new LineWindowChunker({ windowLines: 10, overlapLines: 10 })).toThrow();
  });

  it("chunkShaFor is stable", () => {
    expect(chunkShaFor("hello world")).toBe(chunkShaFor("hello world"));
    expect(chunkShaFor("hello world")).not.toBe(chunkShaFor("hello world!"));
  });
});

describe("chunkFile", () => {
  it("falls back to line-window for prose", () => {
    const chunks = chunkFile("notes.md", "# Title\n\nbody text here\n");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.kind === "window")).toBe(true);
  });

  it("yields stable chunk_sha", () => {
    const a = chunkFile("a.py", "def f():\n    return 1\n");
    const b = chunkFile("a.py", "def f():\n    return 1\n");
    expect(a.map((c) => c.chunkSha)).toEqual(b.map((c) => c.chunkSha));
  });
});
