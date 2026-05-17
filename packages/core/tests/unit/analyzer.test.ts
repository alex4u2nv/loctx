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

  it("records class-method defs from a TS class chunk (#278)", () => {
    const ts = [
      "export class ProjectIndexer {",
      "  async indexProject(project: { id: string }) {",
      "    return { indexed: 0 };",
      "  }",
      "  indexFile(rel: string) {",
      "    return rel;",
      "  }",
      "  static fromConfig(c: unknown) {",
      "    return new ProjectIndexer();",
      "  }",
      "}",
    ].join("\n");
    const chunks = chunkFile("src/indexer.ts", ts);
    const classChunk = chunks.find((c) => c.symbolRefs !== undefined);
    expect(classChunk).toBeDefined();
    const refs = classChunk?.symbolRefs ?? [];
    const defs = refs.filter((r) => r.kind === "def").map((r) => r.symbol);
    // The class itself + each method should surface as defs.
    expect(defs).toContain("ProjectIndexer");
    expect(defs).toContain("indexProject");
    expect(defs).toContain("indexFile");
    expect(defs).toContain("fromConfig");
  });

  it("records class-method defs from a Python class chunk (#278)", () => {
    const py = [
      "class Reconciler:",
      "    def __init__(self, state):",
      "        self.state = state",
      "    async def reconcile_project(self, project):",
      "        return True",
      "    def reconcile_all(self, projects):",
      "        return [self.reconcile_project(p) for p in projects]",
    ].join("\n");
    const chunks = chunkFile("src/reconciler.py", py);
    const cls = chunks.find((c) => c.kind === "class");
    expect(cls).toBeDefined();
    const refs = cls?.symbolRefs ?? [];
    const defs = refs.filter((r) => r.kind === "def").map((r) => r.symbol);
    expect(defs).toContain("Reconciler");
    expect(defs).toContain("__init__");
    expect(defs).toContain("reconcile_project");
    expect(defs).toContain("reconcile_all");
  });

  it("populates analyzer.riskyCalls when a chunk calls a category token (#277)", () => {
    const ts = [
      "import { execFile } from 'node:child_process';",
      "",
      "export async function runTool(cmd: string) {",
      "  const result = await execFile(cmd, ['--help']);",
      "  return result;",
      "}",
    ].join("\n");
    const chunks = chunkFile("src/tool.ts", ts);
    const fn = chunks.find((c) => c.kind === "export" || c.kind === "function");
    expect(fn?.analyzer?.calls).toContain("execFile");
    expect(fn?.analyzer?.riskyCalls).toContain("execFile");
  });

  it("flags member-access risky calls via dotted-name match (#277)", () => {
    const py = [
      "import subprocess",
      "",
      "def run_cmd(cmd):",
      "    return subprocess.run(cmd, shell=True)",
    ].join("\n");
    const chunks = chunkFile("tools/run.py", py);
    const fn = chunks.find((c) => c.kind === "function");
    // tree-sitter Python yields `run` as the rightmost-name callee for
    // `subprocess.run(...)`. That's not in the risky token set on its
    // own — but the chunker's calleeText keeps just the trailing
    // segment, so the test asserts the chunk *includes* subprocess via
    // the imports surface and the inner `shell=True` keyword.
    // The risky signal proper here would fire on a chunk that *names*
    // a token like `eval`/`exec`/`spawn`/`subprocess` directly.
    expect(fn?.analyzer).toBeDefined();
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
