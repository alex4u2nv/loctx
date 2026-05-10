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
    return chunks.length > 0 ? chunks : this.fallback.chunk(document);
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
