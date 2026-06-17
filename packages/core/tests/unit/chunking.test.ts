import { describe, expect, it } from "vitest";
import {
  chunkFile,
  chunkShaFor,
  detectLanguage,
  LANGUAGE_BY_EXTENSION,
  LineWindowChunker,
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

describe("TreeSitterCodeChunker — coverage-gap fill (#360)", () => {
  it("covers builder-pattern callback bodies that tree-sitter misses", () => {
    // Reproduces the cli.ts pattern. Tree-sitter sees the top level
    // as an expression_statement (the whole `program.command(...).
    // action(...)` chain), which is NOT in CHUNKABLE_NODES, so it
    // emits zero chunks for the callback body. The gap-fill catches
    // it so `findModel(name)` ends up in some chunk's content.
    const body = Array.from({ length: 25 }, (_, i) => `      const step${i} = ${i};`).join("\n");
    const source = [
      "import { Command } from 'commander';",
      "",
      "const DAEMON_VERSION = '0.1.0';",
      "",
      "const program = new Command();",
      "program",
      '  .command("model")',
      '  .description("manage embedding models")',
      "  .action(async (name: string) => {",
      '    const { findModel } = await import("@loctx/core");',
      "    const info = findModel(name);",
      body,
      "    return info;",
      "  });",
      "",
    ].join("\n");
    const chunks = chunkFile("cli.ts", source);
    const covered = chunks.some((c) => c.content.includes("findModel(name)"));
    expect(covered).toBe(true);
    // The gap-fill produces a `window-fill` chunk (distinct kind so
    // analytics can tell it apart from line-window emergency
    // fallback). The DAEMON_VERSION declaration at the top is a
    // normal `declaration` chunk; the gap-fill picks up the builder
    // chain below it.
    expect(chunks.map((c) => c.kind)).toContain("window-fill");
  });

  it("covers Python module-level assignments between functions (≥ GAP_THRESHOLD lines)", () => {
    // The #357 case study: a constant defined at module scope between
    // two function definitions. Python's CHUNKABLE_NODES only has
    // function_definition + class_definition; assignment is not in
    // the set. Gap-fill catches the constant when the surrounding
    // module-level region is at least GAP_THRESHOLD_LINES (30) long —
    // a real-world script has comments + the constant + spacing that
    // adds up to that easily.
    const padding = Array.from({ length: 32 }, () => "").join("\n");
    const source = [
      "from pathlib import Path",
      padding,
      "AGENT_MD = Path(__file__).parent / 'agents' / '06-effort-scoring-agent.md'",
      "MODE = 'production'",
      "DEFAULT_TIMEOUT = 30",
      padding,
      "def first():",
      "    return 1",
      padding,
      "def second():",
      "    return AGENT_MD",
      "",
    ].join("\n");
    const chunks = chunkFile("score_connector.py", source);
    const covered = chunks.some((c) =>
      c.content.includes("AGENT_MD = Path(__file__).parent / 'agents'"),
    );
    expect(covered).toBe(true);
  });

  it("ignores short gaps (comments between declarations)", () => {
    // A typical 1-3 line comment block between two functions
    // shouldn't produce a window-fill chunk — that would pollute
    // retrieval. Threshold is GAP_THRESHOLD_LINES.
    const source = [
      "function a() { return 1; }",
      "// comment line 1",
      "// comment line 2",
      "function b() { return 2; }",
    ].join("\n");
    const chunks = chunkFile("a.ts", source);
    // Only the two functions; no window-fill.
    expect(chunks.every((c) => c.kind !== "window-fill")).toBe(true);
  });
});

describe("TreeSitterCodeChunker — size cap (#279)", () => {
  it("splits chunks larger than the hard cap into line-window sub-chunks", () => {
    const inner: string[] = [];
    // Build a single function body with ~150 lines so it exceeds the
    // 120-line hard cap.
    for (let i = 0; i < 150; i++) inner.push(`  const v${i} = ${i};`);
    const source = ["function huge() {", ...inner, "}"].join("\n");

    const chunks = chunkFile("huge.ts", source);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(120);
    }
    // First sub-chunk preserves the function's kind + name; subsequent
    // sub-chunks are "window" with no symbols.
    expect(chunks[0]?.kind).toBe("function");
    expect(chunks[0]?.symbols).toEqual(["huge"]);
    for (const c of chunks.slice(1)) {
      expect(c.kind).toBe("window");
      expect(c.symbols).toEqual([]);
    }
    // Combined ranges cover the original chunk's span (with overlap).
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks.at(-1)?.endLine).toBeGreaterThanOrEqual(150);
  });

  it("leaves chunks under the cap untouched", () => {
    const source = [
      "function small() {",
      "  return 1;",
      "}",
      "",
      "function alsoSmall() {",
      "  return 2;",
      "}",
    ].join("\n");
    const chunks = chunkFile("small.ts", source);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.kind === "function")).toBe(true);
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
