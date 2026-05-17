import { describe, expect, it } from "vitest";
import { chunkFile } from "../../src/chunking/index.js";
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

describe("AST extraction via chunker (#59)", () => {
  it("extracts imports + calls + paramCount + hasAsync from a TS function", () => {
    const ts = [
      "import { verifyJwt } from './jwt';",
      "",
      "async function authenticateUser(token: string, opts: { strict: boolean }) {",
      "  const claims = await verifyJwt(token);",
      "  if (!claims) throw new Error('bad token');",
      "  return claims;",
      "}",
      "",
    ].join("\n");
    const chunks = chunkFile("src/auth.ts", ts);
    const fn = chunks.find((c) => c.symbols[0] === "authenticateUser");
    expect(fn?.analyzer).toBeDefined();
    const meta = fn?.analyzer;
    expect(meta?.calls).toContain("verifyJwt");
    expect(meta?.paramCount).toBe(2);
    expect(meta?.hasAsync).toBe(true);
    expect(meta?.analysisSource).toBe("tree-sitter");
    expect(meta?.analysisVersion).toBe(1);
  });

  it("extracts imports + calls from a Python function", () => {
    const py = [
      "from os import path",
      "import json",
      "",
      "def parse_config(raw: str) -> dict:",
      "    data = json.loads(raw)",
      "    return data",
      "",
    ].join("\n");
    const chunks = chunkFile("tools/config.py", py);
    const fn = chunks.find((c) => c.kind === "function");
    expect(fn?.analyzer).toBeDefined();
    const meta = fn?.analyzer;
    expect(meta?.calls).toContain("loads");
    expect(meta?.paramCount).toBe(1);
    expect(meta?.hasAsync).toBe(false);
  });

  it("extracts nesting depth from nested loops/blocks", () => {
    const ts = [
      "function deep() {",
      "  for (let i = 0; i < 3; i++) {",
      "    if (i % 2 === 0) {",
      "      while (true) { break; }",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const chunks = chunkFile("src/deep.ts", ts);
    const fn = chunks.find((c) => c.kind === "function");
    expect(fn?.analyzer?.maxNestingDepth).toBeGreaterThanOrEqual(2);
    expect(fn?.analyzer?.maxLoopDepth).toBeGreaterThanOrEqual(2);
  });

  it("leaves analyzer undefined for non-code chunks (markdown)", () => {
    const md = "# Title\n\nbody text\n";
    const chunks = chunkFile("notes.md", md);
    expect(chunks[0]?.analyzer).toBeUndefined();
  });
});

describe("Symbol cross-reference extraction (#96)", () => {
  it("records def + every callee from a TS function (export_statement wrapper)", () => {
    const ts = [
      "import { verifyJwt } from './jwt';",
      "",
      "export async function authenticateUser(token: string) {",
      "  const claims = await verifyJwt(token);",
      "  return claims;",
      "}",
      "",
    ].join("\n");
    const chunks = chunkFile("src/auth.ts", ts);
    // The chunker emits one chunk for the export_statement wrapping the
    // async function. extractSymbolRefs unwraps it for the def.
    const fn = chunks.find((c) => c.symbolRefs !== undefined);
    expect(fn?.symbolRefs).toBeDefined();
    const refs = fn?.symbolRefs ?? [];
    const def = refs.find((r) => r.kind === "def");
    expect(def?.symbol).toBe("authenticateUser");
    const callees = refs.filter((r) => r.kind === "call").map((r) => r.symbol);
    expect(callees).toContain("verifyJwt");
  });

  it("records imports inside a chunk as kind=import", () => {
    // Imports DECLARED INSIDE a function (legal in Python) live inside
    // the function chunk's subtree and surface naturally.
    const py = [
      "def load_config(path):",
      "    import tomllib",
      "    return tomllib.loads(open(path).read())",
      "",
    ].join("\n");
    const chunks = chunkFile("tools/cfg.py", py);
    const fn = chunks.find((c) => c.kind === "function");
    const imports = (fn?.symbolRefs ?? []).filter((r) => r.kind === "import").map((r) => r.symbol);
    expect(imports.length).toBeGreaterThan(0);
  });

  it("attaches file-level imports' refs to the first chunk (#274/#273)", () => {
    // Top-level imports aren't their own chunks (would add retrieval
    // noise — see eval gate in #274 commit). Instead, the chunker
    // walks the file's root for import statements and attaches each
    // named identifier as a `kind: import` ref to the first chunk.
    const ts = [
      "import { SnippetModal } from '../components/snippet-modal';",
      "import { highlightCode } from '../lib/highlight';",
      "import * as React from 'react';",
      "",
      "export function ProjectDetailPage() {",
      "  return <SnippetModal title='x' snippet='y' onClose={() => {}} />;",
      "}",
      "",
    ].join("\n");
    const chunks = chunkFile("apps/web/client/routes/project-detail.tsx", ts);
    expect(chunks.length).toBeGreaterThan(0);
    const first = chunks[0];
    expect(first).toBeDefined();
    const imports = (first?.symbolRefs ?? [])
      .filter((r) => r.kind === "import")
      .map((r) => r.symbol);
    // Every named identifier should be captured — both braced imports
    // and namespace imports. The line each points at is the import
    // statement's line in the file.
    expect(imports).toContain("SnippetModal");
    expect(imports).toContain("highlightCode");
    expect(imports).toContain("React");
    // The chunker should NOT have created its own import chunk —
    // imports stay attached to the first real chunk to avoid
    // retrieval-noise regressions.
    expect(chunks.every((c) => c.kind !== "import")).toBe(true);
  });

  it("populates analyzer.exports for export_statement chunks (#274)", () => {
    const ts = [
      "export function alpha(x: number) { return x + 1; }",
      "",
      "export class Beta { run() {} }",
      "",
      "export const gamma = 1, delta = 2;",
      "",
      "export interface Epsilon { id: number; }",
    ].join("\n");
    const chunks = chunkFile("src/x.ts", ts);
    // Collect every export name across every chunk.
    const allExports = chunks.flatMap((c) => c.analyzer?.exports ?? []);
    expect(allExports).toEqual(
      expect.arrayContaining(["alpha", "Beta", "gamma", "delta", "Epsilon"]),
    );
  });

  it("attaches imported module specifiers to the first chunk's analyzer.imports", () => {
    const ts = [
      "import { Foo } from './foo';",
      "import { Bar } from 'node:fs';",
      "",
      "export const baz = 1;",
    ].join("\n");
    const chunks = chunkFile("src/x.ts", ts);
    const first = chunks[0];
    expect(first?.analyzer?.imports).toEqual(expect.arrayContaining(["./foo", "node:fs"]));
  });

  it("excludes parameters and local variables (call_match noise)", () => {
    const ts = [
      "function f(name: string) {",
      "  const localVar = 1;",
      "  return localVar;",
      "}",
    ].join("\n");
    const chunks = chunkFile("src/f.ts", ts);
    const fn = chunks.find((c) => c.kind === "function");
    const refs = fn?.symbolRefs ?? [];
    const symbols = refs.map((r) => r.symbol);
    // The def is recorded; bare identifier references aren't.
    expect(symbols).toContain("f");
    expect(symbols).not.toContain("name");
    expect(symbols).not.toContain("localVar");
  });

  it("returns empty for languages without a profile", () => {
    // Markdown-as-code path: chunkFile dispatches to the markdown chunker
    // which doesn't produce symbolRefs at all.
    const chunks = chunkFile("notes.md", "# heading");
    expect(chunks[0]?.symbolRefs).toBeUndefined();
  });
});
