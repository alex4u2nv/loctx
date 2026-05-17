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
import { extractAnalyzer, extractSymbolRefs } from "./analyzer.js";
import { type Chunker, type CodeChunk, type SourceDocument, chunkShaFor } from "./base.js";
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
    const chunks: CodeChunk[] = [];
    for (const node of tree.rootNode.namedChildren) {
      if (!chunkable.has(node.type)) continue;
      chunks.push(chunkFromNode(node, document.content, language));
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
    return chunks;
  }
}

function chunkFromNode(node: TreeSitterNode, source: string, language: string): CodeChunk {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const lines = source.split(/\r?\n/);
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
    const target = importModuleText(node);
    if (target !== null && target !== "") modules.push(target);
    for (const name of extractNamedImports(node)) {
      refs.push({ symbol: name, kind: "import", line });
    }
  }

  return { modules: dedupeStrings(modules), refs };
}

/**
 * Pull the module specifier out of an import-shape node. Matches the
 * heuristics in analyzer.ts's importTargetText, but kept local so this
 * file owns its imports surface end-to-end.
 */
function importModuleText(node: TreeSitterNode): string | null {
  for (const field of ["source", "module", "argument", "name"]) {
    const child = node.childForFieldName(field);
    if (child !== null && child.text.length > 0) return stripImportQuotes(child.text);
  }
  for (const child of node.namedChildren) {
    if (
      child.type === "string" ||
      child.type === "string_literal" ||
      child.type === "raw_string_literal"
    ) {
      return stripImportQuotes(child.text);
    }
  }
  return null;
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

function stripImportQuotes(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

function dedupeStrings(items: ReadonlyArray<string>): string[] {
  return [...new Set(items)];
}

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
