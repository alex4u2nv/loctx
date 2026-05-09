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
  it("routes .md through the markdown chunker (section-aware)", () => {
    const chunks = chunkFile("notes.md", "# Title\n\nbody text here\n");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.kind).toBe("section-h1");
    expect(chunks[0]?.symbols[0]).toBe("Title");
  });

  it("falls back to line-window for unsupported extensions", () => {
    const chunks = chunkFile("notes.txt", "no headings, just prose lines\nline two\nline three\n");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.kind === "window")).toBe(true);
  });

  it("yields stable chunk_sha", () => {
    const a = chunkFile("a.py", "def f():\n    return 1\n");
    const b = chunkFile("a.py", "def f():\n    return 1\n");
    expect(a.map((c) => c.chunkSha)).toEqual(b.map((c) => c.chunkSha));
  });
});

describe("TreeSitterCodeChunker — Python", () => {
  it("emits one chunk per top-level function and class with names", () => {
    const source = [
      "def hello():",
      "    return 1",
      "",
      "",
      "class Greeter:",
      "    def greet(self):",
      "        return hello()",
      "",
    ].join("\n");
    const chunks = chunkFile("module.py", source);
    expect(chunks.length).toBe(2);

    const fn = chunks.find((c) => c.kind === "function");
    const cls = chunks.find((c) => c.kind === "class");
    expect(fn?.symbols).toEqual(["hello"]);
    expect(cls?.symbols).toEqual(["Greeter"]);
    expect(fn?.startLine).toBe(1);
    expect(cls?.startLine).toBe(5);
  });

  it("recovers function name from a decorated definition", () => {
    const source = ["@some.decorator", "def decorated():", "    return 'x'", ""].join("\n");
    const chunks = chunkFile("decorated.py", source);
    expect(chunks.length).toBe(1);
    // decorated_definition wraps function_definition; symbols recurse to find the name.
    expect(chunks[0]?.symbols).toEqual(["decorated"]);
  });

  it("falls back to line-window when there are no top-level definitions", () => {
    const chunks = chunkFile("imports.py", "import os\nimport sys\n\nx = 1\n");
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.kind).toBe("window");
  });
});

describe("TreeSitterCodeChunker — TypeScript", () => {
  it("emits chunks for functions, classes, and interfaces", () => {
    const source = [
      "export interface Greeter { greet(): string }",
      "",
      "export class Hi implements Greeter {",
      "  greet() { return 'hi'; }",
      "}",
      "",
      "function topLevel() { return 1; }",
      "",
    ].join("\n");
    const chunks = chunkFile("a.ts", source);
    const kinds = chunks.map((c) => c.kind);
    expect(kinds).toContain("function");
    expect(kinds.some((k) => k === "class" || k === "export")).toBe(true);
    expect(kinds.some((k) => k === "interface" || k === "export")).toBe(true);
  });
});

describe("TreeSitterCodeChunker — Go", () => {
  it("emits chunks for top-level function and type declarations", () => {
    const source = [
      "package main",
      "",
      "type Greeter struct { Name string }",
      "",
      "func (g Greeter) Greet() string {",
      "  return g.Name",
      "}",
      "",
      "func main() {",
      '  println("hi")',
      "}",
      "",
    ].join("\n");
    const chunks = chunkFile("main.go", source);
    const kinds = chunks.map((c) => c.kind);
    expect(kinds).toContain("function");
    expect(kinds).toContain("method");
    expect(kinds).toContain("type");
  });
});
