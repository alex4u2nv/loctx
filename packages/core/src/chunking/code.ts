/**
 * Tree-sitter chunker — emits one chunk per top-level definition (function,
 * class, struct, etc.) using `tree-sitter` + per-language native modules.
 *
 * Each language is loaded lazily on first use and memoized. Loading happens
 * via `createRequire` because tree-sitter's language packages are CJS;
 * dynamic ESM `import()` of CJS works but adds a microtick we don't need.
 *
 * Files whose language is unsupported, or whose parse yields no recognized
 * top-level definitions, fall back to the line-window chunker — the caller
 * always gets at least one chunk for non-empty input.
 */

import { createRequire } from "node:module";
import { dedupeStrings, extractAnalyzer, extractSymbolRefs, importTargetText } from "./analyzer.js";
import { type Chunker, type CodeChunk, chunkShaFor, type SourceDocument } from "./base.js";
import { LineWindowChunker } from "./prose.js";

const require = createRequire(import.meta.url);

// Extension → loctx language label. Kept in sync with the Python port so the
// vector index's `language` metadata stays comparable across implementations.
// Languages without an active tree-sitter parser fall through to the
// line-window chunker.
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".mkd": "markdown",
});

// Top-level node types that we treat as standalone chunks per language.
const CHUNKABLE_NODES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  python: new Set([
    "function_definition",
    "class_definition",
    "decorated_definition",
    "async_function_definition",
  ]),
  javascript: new Set([
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "lexical_declaration",
    "variable_declaration",
    "export_statement",
  ]),
  typescript: new Set([
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "lexical_declaration",
    "export_statement",
  ]),
  tsx: new Set([
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "lexical_declaration",
    "export_statement",
  ]),
  go: new Set(["function_declaration", "method_declaration", "type_declaration"]),
  rust: new Set([
    "function_item",
    "struct_item",
    "impl_item",
    "enum_item",
    "trait_item",
    "mod_item",
  ]),
  java: new Set(["method_declaration", "class_declaration", "interface_declaration"]),
});

const KIND_BY_NODE: Readonly<Record<string, string>> = Object.freeze({
  function_definition: "function",
  function_declaration: "function",
  generator_function_declaration: "function",
  function_item: "function",
  async_function_definition: "function",
  method_definition: "method",
  method_declaration: "method",
  class_definition: "class",
  class_declaration: "class",
  decorated_definition: "definition",
  struct_item: "struct",
  impl_item: "impl",
  enum_item: "enum",
  enum_declaration: "enum",
  trait_item: "trait",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  type_declaration: "type",
  lexical_declaration: "declaration",
  variable_declaration: "declaration",
  export_statement: "export",
  mod_item: "module",
});

export function detectLanguage(relPath: string): string | null {
  const name = relPath.split("/").at(-1) ?? relPath;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const suffix = name.slice(dot).toLowerCase();
  return LANGUAGE_BY_EXTENSION[suffix] ?? null;
}

// ---- tree-sitter wiring ------------------------------------------------

interface TreeSitterNode {
  readonly type: string;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly namedChildren: ReadonlyArray<TreeSitterNode>;
  readonly children: ReadonlyArray<TreeSitterNode>;
  childForFieldName(name: string): TreeSitterNode | null;
  readonly text: string;
}

interface TreeSitterParser {
  parse(text: string): { rootNode: TreeSitterNode };
}

type ParserCtor = new () => TreeSitterParser & { setLanguage(lang: unknown): void };

const parserCache = new Map<string, TreeSitterParser | null>();

function getParser(language: string): TreeSitterParser | null {
  if (parserCache.has(language)) return parserCache.get(language) ?? null;
  const parser = loadParser(language);
  parserCache.set(language, parser);
  return parser;
}

function loadParser(language: string): TreeSitterParser | null {
  if (!Object.hasOwn(CHUNKABLE_NODES, language)) return null;
  try {
    const Parser = require("tree-sitter") as ParserCtor;
    const grammar = loadGrammar(language);
    if (grammar === null) return null;
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser;
  } catch {
    return null;
  }
}

function loadGrammar(language: string): unknown {
  try {
    switch (language) {
      case "python":
        return require("tree-sitter-python");
      case "javascript":
        return require("tree-sitter-javascript");
      case "typescript":
        return (require("tree-sitter-typescript") as { typescript: unknown }).typescript;
      case "tsx":
        return (require("tree-sitter-typescript") as { tsx: unknown }).tsx;
      case "go":
        return require("tree-sitter-go");
      case "rust":
        return require("tree-sitter-rust");
      case "java":
        return require("tree-sitter-java");
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---- chunker -----------------------------------------------------------

export interface CodeChunkerOptions {
  readonly fallback?: Chunker;
}

export class TreeSitterCodeChunker implements Chunker {
  private readonly fallback: Chunker;

  constructor(options: CodeChunkerOptions = {}) {
    this.fallback = options.fallback ?? new LineWindowChunker();
  }

  chunk(document: SourceDocument): CodeChunk[] {
    const language = document.language;
    if (language === null || !Object.hasOwn(CHUNKABLE_NODES, language)) {
      return this.fallback.chunk(document);
    }

    const parser = getParser(language);
    if (parser === null) {
      return this.fallback.chunk(document);
    }

    let tree: { rootNode: TreeSitterNode };
    try {
      tree = parser.parse(document.content);
    } catch {
      return this.fallback.chunk(document);
    }

    const chunkable = CHUNKABLE_NODES[language] as ReadonlySet<string>;
    // Split ONCE per file. This used to happen inside chunkFromNode —
    // once per top-level node — making indexing cost scale with
    // fileLength × definitionCount (#444). The same array is threaded
    // through gap-fill below.
    const lines = document.content.split(/\r?\n/);
    const chunks: CodeChunk[] = [];
    for (const node of tree.rootNode.namedChildren) {
      if (!chunkable.has(node.type)) continue;
      chunks.push(chunkFromNode(node, lines, language));
    }
    if (chunks.length === 0) return this.fallback.chunk(document);

    // #274/#273: top-level imports aren't chunked (avoids retrieval
    // noise — every import line becoming its own chunk would let
    // lexical hits on imported names outrank real definitions). But
    // we still need their analyzer.imports + symbol_refs so find_usages
    // can answer "who imports this?". Solution: walk the file's root
    // children for import-shaped nodes, collect modules + named
    // identifiers, and bolt them onto the FIRST chunk's payload.
    const fileImports = extractFileLevelImports(tree.rootNode, language);
    if (fileImports.modules.length > 0 || fileImports.refs.length > 0) {
      const first = chunks[0];
      if (first !== undefined) {
        chunks[0] = withFileImports(first, fileImports);
      }
    }
    // #360: tree-sitter only emits chunks for top-level nodes in
    // CHUNKABLE_NODES. That misses (a) callback bodies in
    // fluent-builder patterns like `program.command(...).action(async
    // () => { ... })` — the action body sits inside a call_expression,
    // not a top-level function_declaration — and (b) Python module-
    // level assignments like `AGENT_MD = Path(...)`. Both produced
    // invisible content: find_usages undercounted refs, find_literal
    // missed the line, retrieval skipped the snippet. Fill any gap
    // > GAP_THRESHOLD_LINES with the line-window fallback so every
    // line of source ends up in some chunk. The threshold keeps
    // 1-3-line comment-only gaps from polluting the index.
    const filled = fillCoverageGaps(chunks, document, lines, language);
    return capChunkSizes(filled);
  }
}

/**
 * A gap shorter than this is skipped. Bumped from 10 → 30 (#360
 * follow-up) so we only chunk *substantial* uncovered regions.
 * Smaller comment-only gaps don't pollute retrieval.
 */
const GAP_THRESHOLD_LINES = 30;

/**
 * Dedicated line-window chunker for gap-fill — uses LARGER windows
 * (120 lines, 20 overlap = 100-line step) than the emergency-fallback
 * default (60/10). Empirically the gap-fill chunks were doubling per-
 * file chunk counts on builder-heavy files like cli.ts (22 → 50).
 * Doubling the window halves the gap-fill output without hurting
 * recall — the embedder sees the same source bytes, just packed into
 * fewer (larger) chunks. The downside is that BM25 lexical hits land
 * on coarser chunks. Acceptable for window-fill (the gap-filler is
 * the safety net, not the primary retrieval path).
 */
const GAP_FILL_CHUNKER = new LineWindowChunker({ windowLines: 120, overlapLines: 20 });

/**
 * Walk the tree-sitter chunk list, find uncovered line ranges
 * (`endLine + 1 .. nextStartLine - 1`, plus the head and tail of the
 * file), and run the fallback line-window chunker over each gap
 * >= GAP_THRESHOLD_LINES. The output is merged with the tree-sitter
 * chunks and sorted by start line. Tagged with `kind: "window-fill"`
 * so analytics can tell line-window-from-gap chunks apart from
 * tree-sitter's own line-window emergency fallback.
 */
function fillCoverageGaps(
  treeChunks: CodeChunk[],
  document: SourceDocument,
  lines: ReadonlyArray<string>,
  language: string,
): CodeChunk[] {
  if (treeChunks.length === 0) return treeChunks;
  const sorted = [...treeChunks].sort((a, b) => a.startLine - b.startLine);
  const trailingBlank = lines.at(-1) === "" && lines.length > 1;
  const totalLines = trailingBlank ? lines.length - 1 : lines.length;
  if (totalLines <= 0) return treeChunks;

  const out: CodeChunk[] = [];
  let cursor = 1;
  for (const c of sorted) {
    if (c.startLine - 1 >= cursor + GAP_THRESHOLD_LINES - 1) {
      out.push(
        ...chunkLineRange({
          document,
          lines,
          chunker: GAP_FILL_CHUNKER,
          startLine: cursor,
          endLine: c.startLine - 1,
          language,
        }),
      );
    }
    out.push(c);
    cursor = Math.max(cursor, c.endLine + 1);
  }
  if (totalLines - cursor + 1 >= GAP_THRESHOLD_LINES) {
    out.push(
      ...chunkLineRange({
        document,
        lines,
        chunker: GAP_FILL_CHUNKER,
        startLine: cursor,
        endLine: totalLines,
        language,
      }),
    );
  }
  return out.sort((a, b) => a.startLine - b.startLine);
}

/**
 * Slice `document` to lines [startLine, endLine] (1-indexed, inclusive)
 * and run the line-window chunker on the slice. Returned chunks have
 * their line numbers translated back to the file's coordinate system.
 * Each window also gets tree-sitter analyzer + symbol_refs extraction
 * on the slice text — without that step `find_usages` would still
 * undercount refs sitting in window-fill chunks (the original #360
 * complaint). tree-sitter is error-tolerant; even if the slice
 * starts/ends mid-construct, top-level call/import nodes still
 * yield extractable refs.
 */
interface LineRangeInput {
  readonly document: SourceDocument;
  readonly lines: ReadonlyArray<string>;
  readonly chunker: Chunker;
  readonly startLine: number;
  readonly endLine: number;
  readonly language: string;
}

function chunkLineRange({
  document,
  lines,
  chunker,
  startLine,
  endLine,
  language,
}: LineRangeInput): CodeChunk[] {
  const slice = lines.slice(startLine - 1, endLine).join("\n");
  if (slice.trim() === "") return [];
  const sliceDoc: SourceDocument = {
    ...document,
    content: slice,
  };
  const windowChunks = chunker.chunk(sliceDoc);
  return windowChunks.map((c) => {
    const refsAndAnalyzer = extractRefsFromSlice(c.content, language);
    return {
      ...c,
      startLine: c.startLine + startLine - 1,
      endLine: c.endLine + startLine - 1,
      kind: "window-fill",
      ...(refsAndAnalyzer.analyzer !== null ? { analyzer: refsAndAnalyzer.analyzer } : {}),
      ...(refsAndAnalyzer.symbolRefs.length > 0 ? { symbolRefs: refsAndAnalyzer.symbolRefs } : {}),
    };
  });
}

/**
 * Parse a window-fill slice with tree-sitter (error-tolerant) and pull
 * analyzer metadata + symbol_refs out of the root. Used so window-fill
 * chunks carry the same metadata as tree-sitter-native chunks — without
 * this, find_usages misses any call/import that fell into a chunker
 * coverage gap.
 */
function extractRefsFromSlice(
  source: string,
  language: string,
): {
  analyzer: ReturnType<typeof extractAnalyzer>;
  symbolRefs: ReturnType<typeof extractSymbolRefs>;
} {
  if (!Object.hasOwn(CHUNKABLE_NODES, language)) {
    return { analyzer: null, symbolRefs: [] };
  }
  const parser = getParser(language);
  if (parser === null) return { analyzer: null, symbolRefs: [] };
  let tree: { rootNode: TreeSitterNode };
  try {
    tree = parser.parse(source);
  } catch {
    return { analyzer: null, symbolRefs: [] };
  }
  return {
    analyzer: extractAnalyzer(tree.rootNode, language),
    symbolRefs: extractSymbolRefs(tree.rootNode, language),
  };
}

// ---- hard size cap (#279) ----------------------------------------------

const HARD_MAX_LINES = 120;
const SUBWINDOW_LINES = 60;
const SUBWINDOW_OVERLAP = 10;

// When a top-level chunk exceeds HARD_MAX_LINES, split its body via the
// line-window chunker and re-offset line numbers back to the file. The
// kind/symbols/analyzer/symbolRefs of the original chunk go on the first
// sub-chunk only — that's where the unit's definitional metadata lives.
function capChunkSizes(chunks: ReadonlyArray<CodeChunk>): CodeChunk[] {
  let oversized = false;
  for (const c of chunks) {
    if (c.endLine - c.startLine + 1 > HARD_MAX_LINES) {
      oversized = true;
      break;
    }
  }
  if (!oversized) return [...chunks];

  const splitter = new LineWindowChunker({
    windowLines: SUBWINDOW_LINES,
    overlapLines: SUBWINDOW_OVERLAP,
  });
  const out: CodeChunk[] = [];
  for (const c of chunks) {
    if (c.endLine - c.startLine + 1 <= HARD_MAX_LINES) {
      out.push(c);
      continue;
    }
    const subs = splitter.chunk({
      relPath: "",
      content: c.content,
      language: null,
    });
    if (subs.length <= 1) {
      out.push(c);
      continue;
    }
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      if (sub === undefined) continue;
      const offsetStart = c.startLine + sub.startLine - 1;
      const offsetEnd = c.startLine + sub.endLine - 1;
      const isFirst = i === 0;
      out.push({
        startLine: offsetStart,
        endLine: offsetEnd,
        content: sub.content,
        kind: isFirst ? c.kind : "window",
        symbols: isFirst ? c.symbols : Object.freeze([]),
        chunkSha: sub.chunkSha,
        ...(isFirst && c.analyzer !== undefined ? { analyzer: c.analyzer } : {}),
        ...(isFirst && c.symbolRefs !== undefined && c.symbolRefs.length > 0
          ? { symbolRefs: c.symbolRefs }
          : {}),
      });
    }
  }
  return out;
}

function chunkFromNode(
  node: TreeSitterNode,
  lines: ReadonlyArray<string>,
  language: string,
): CodeChunk {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const body = lines.slice(startLine - 1, endLine).join("\n");
  const analyzer = extractAnalyzer(node, language);
  const symbolRefs = extractSymbolRefs(node, language);
  return {
    startLine,
    endLine,
    content: body,
    kind: KIND_BY_NODE[node.type] ?? "definition",
    symbols: extractSymbols(node),
    chunkSha: chunkShaFor(body),
    ...(analyzer !== null ? { analyzer } : {}),
    ...(symbolRefs.length > 0 ? { symbolRefs } : {}),
  };
}

// ---- file-level imports (#274/#273) ------------------------------------

interface FileImports {
  /** Module specifiers (e.g. "./snippet-modal", "node:fs"). */
  readonly modules: ReadonlyArray<string>;
  /** One symbol_refs row per named import, with `kind: "import"`. */
  readonly refs: ReadonlyArray<{ symbol: string; kind: "import"; line: number }>;
}

/** Per-language node types that wrap a top-level import statement. */
const IMPORT_NODES_BY_LANGUAGE: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  javascript: new Set(["import_statement"]),
  typescript: new Set(["import_statement"]),
  tsx: new Set(["import_statement"]),
  python: new Set(["import_statement", "import_from_statement"]),
  go: new Set(["import_declaration"]),
  rust: new Set(["use_declaration"]),
  java: new Set(["import_declaration"]),
});

function extractFileLevelImports(root: TreeSitterNode, language: string): FileImports {
  const importNodes = IMPORT_NODES_BY_LANGUAGE[language];
  if (importNodes === undefined) return { modules: [], refs: [] };

  const modules: string[] = [];
  const refs: { symbol: string; kind: "import"; line: number }[] = [];

  for (const node of root.namedChildren) {
    if (!importNodes.has(node.type)) continue;
    const line = node.startPosition.row + 1;
    const target = importTargetText(node);
    if (target !== null && target !== "") modules.push(target);
    for (const name of extractNamedImports(node)) {
      refs.push({ symbol: name, kind: "import", line });
    }
  }

  return { modules: dedupeStrings(modules), refs };
}

/**
 * Pull every named imported identifier out of an import-shape node.
 *   - JS/TS `import { A, B as C } from "x"` → ["A", "B"]
 *   - JS/TS `import D from "x"` (default)   → ["D"]
 *   - JS/TS `import * as ns from "x"`       → ["ns"]
 *   - Python `from x import A, B`           → ["A", "B"]
 *   - Python `import x` / `import x as y`   → ["x"] / ["y"]
 *   - Go/Java/Rust currently return [] — the module specifier alone is
 *     useful for analyzer.imports, but the named-symbol shape varies
 *     enough that we extend per-language in follow-ups.
 */
function extractNamedImports(node: TreeSitterNode): string[] {
  const names: string[] = [];
  collectIdentifiers(node, names);
  return dedupeStrings(names);
}

const IMPORT_SUBNODES_TO_DESCEND = new Set([
  "import_clause",
  "named_imports",
  "namespace_import",
  "import_specifier",
  "default_import",
  "dotted_name",
  "aliased_import",
  "import_list",
]);

function collectIdentifiers(node: TreeSitterNode, out: string[]): void {
  if (node.type === "identifier" || node.type === "type_identifier") {
    if (node.text.length > 0) out.push(node.text);
    return;
  }
  if (
    node.type === "import_specifier" ||
    node.type === "aliased_import" ||
    node.type === "namespace_import"
  ) {
    // Prefer the "name" field when present (handles `B as C` → "B").
    const named = node.childForFieldName("name");
    if (named !== null && named.text.length > 0) {
      out.push(named.text);
      return;
    }
  }
  if (
    !IMPORT_SUBNODES_TO_DESCEND.has(node.type) &&
    node.type !== "import_statement" &&
    node.type !== "import_from_statement"
  ) {
    // Don't descend into arbitrary nodes — keep the walk tight to
    // the import-clause subtree.
    if (node.namedChildren.length > 0 && node.namedChildren[0]?.type === "identifier") {
      // shallow fallthrough — top-level imports in TS land here for
      // the default-import + namespace-import shapes that don't have
      // a dedicated wrapper.
    } else {
      return;
    }
  }
  for (const child of node.namedChildren) {
    collectIdentifiers(child, out);
  }
}

// importTargetText / stripImportQuotes / dedupeStrings are imported from
// analyzer.ts (CORE-7) — the byte-identical local copies fed the same
// symbol_refs table, so drift was a correctness risk.

/**
 * Merge file-level import data into the chunk we picked (the first
 * one). The chunk's content/lines stay unchanged so the embedding is
 * unaffected; only the analyzer.imports + symbolRefs metadata gains
 * the file's import information.
 */
function withFileImports(chunk: CodeChunk, fileImports: FileImports): CodeChunk {
  const analyzer = chunk.analyzer;
  const mergedAnalyzer =
    analyzer !== undefined
      ? {
          ...analyzer,
          imports: Object.freeze(dedupeStrings([...analyzer.imports, ...fileImports.modules])),
        }
      : undefined;
  const mergedSymbolRefs = [...(chunk.symbolRefs ?? []), ...fileImports.refs];
  return {
    ...chunk,
    ...(mergedAnalyzer !== undefined ? { analyzer: mergedAnalyzer } : {}),
    ...(mergedSymbolRefs.length > 0 ? { symbolRefs: mergedSymbolRefs } : {}),
  };
}

function extractSymbols(node: TreeSitterNode): ReadonlyArray<string> {
  const named = node.childForFieldName("name");
  if (named !== null && named.text.length > 0) {
    return Object.freeze([named.text]);
  }
  // decorated_definition (Python) wraps the actual function/class.
  if (node.type === "decorated_definition") {
    for (const child of node.children) {
      if (child.type === "function_definition" || child.type === "class_definition") {
        return extractSymbols(child);
      }
    }
  }
  return Object.freeze([]);
}
