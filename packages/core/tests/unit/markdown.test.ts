import { describe, expect, it } from "vitest";
import { chunkFile, MarkdownChunker } from "../../src/chunking/index.js";

describe("MarkdownChunker", () => {
  const chunker = new MarkdownChunker();

  it("returns empty for empty input", () => {
    expect(chunker.chunk({ relPath: "x.md", content: "", language: "markdown" })).toEqual([]);
  });

  it("splits at top-level headings", () => {
    const md =
      "# Intro\n\nWelcome paragraph.\n\n# Setup\n\nInstall steps.\n\n# Usage\n\nRun loctx.";
    const chunks = chunker.chunk({ relPath: "guide.md", content: md, language: "markdown" });
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.symbols[0])).toEqual(["Intro", "Setup", "Usage"]);
    expect(chunks[0]?.kind).toBe("section-h1");
    expect(chunks[0]?.startLine).toBe(1);
  });

  it("preserves heading hierarchy in symbols", () => {
    const md = "# Top\n\n## Middle\n\nbody\n\n### Leaf\n\nmore body\n\n## Other\n\nx";
    const chunks = chunker.chunk({ relPath: "x.md", content: md, language: "markdown" });
    const symbolPaths = chunks.map((c) => [...c.symbols]);
    expect(symbolPaths).toEqual([
      ["Top"],
      ["Top", "Middle"],
      ["Top", "Middle", "Leaf"],
      ["Top", "Other"],
    ]);
  });

  it("attaches frontmatter to the first chunk", () => {
    const md = "---\nname: example\n---\n\n# Title\n\nbody";
    const chunks = chunker.chunk({ relPath: "x.md", content: md, language: "markdown" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain("name: example");
    expect(chunks[0]?.content).toContain("# Title");
    expect(chunks[0]?.startLine).toBe(1);
  });

  it("ignores headings inside fenced code blocks", () => {
    const md =
      "# Real\n\n```python\n# This is a comment, not a heading\ndef f():\n    pass\n```\n\nstill in Real.\n\n# Next\n\nbody";
    const chunks = chunker.chunk({ relPath: "x.md", content: md, language: "markdown" });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.symbols[0]).toBe("Real");
    expect(chunks[0]?.content).toContain("def f():");
    expect(chunks[1]?.symbols[0]).toBe("Next");
  });

  it("falls back to line windows when there are no headings", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = chunker.chunk({ relPath: "notes.md", content: lines, language: "markdown" });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.kind).toBe("window");
  });

  it("splits oversized sections via line-window fallback", () => {
    const body = Array.from({ length: 300 }, (_, i) => `body line ${i + 1}`).join("\n");
    const md = `# Big\n\n${body}`;
    const chunks = chunker.chunk({ relPath: "x.md", content: md, language: "markdown" });
    expect(chunks.length).toBeGreaterThan(1);
    // Heading path should propagate to every sub-chunk.
    for (const c of chunks) {
      expect(c.symbols[0]).toBe("Big");
      expect(c.kind).toBe("section-h1");
    }
  });

  it("emits 1-indexed line ranges", () => {
    const md = "# A\n\nbody A\n\n# B\n\nbody B";
    const chunks = chunker.chunk({ relPath: "x.md", content: md, language: "markdown" });
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[1]?.startLine).toBe(5);
    expect(chunks[1]?.endLine).toBeGreaterThanOrEqual(5);
  });
});

describe("chunkFile dispatch", () => {
  it("routes .md through MarkdownChunker", () => {
    const md = "# Hello\n\nworld";
    const chunks = chunkFile("notes/x.md", md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.symbols[0]).toBe("Hello");
    expect(chunks[0]?.kind).toBe("section-h1");
  });

  it("routes .mdx through MarkdownChunker", () => {
    const mdx = "# Component\n\n<Foo />";
    const chunks = chunkFile("docs/foo.mdx", mdx);
    expect(chunks[0]?.symbols[0]).toBe("Component");
  });

  it("falls through to tree-sitter for code files", () => {
    const ts = `export function hello(): string { return "hi"; }`;
    const chunks = chunkFile("src/x.ts", ts);
    expect(chunks.length).toBeGreaterThan(0);
    // Tree-sitter returns kind from CHUNKABLE_NODE_KINDS, never "section-h*".
    expect(chunks.every((c) => !c.kind.startsWith("section-h"))).toBe(true);
  });
});
