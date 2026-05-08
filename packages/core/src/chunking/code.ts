/**
 * Tree-sitter-backed chunker (placeholder).
 *
 * The Python implementation uses `tree-sitter-language-pack` to walk the
 * parse tree and emit one chunk per top-level definition. The Node port
 * will use `web-tree-sitter` + WASM grammars to do the same — this is a
 * follow-up. Until then, the chunker delegates to `LineWindowChunker`
 * (the same fallback the Python `TreeSitterCodeChunker` uses for
 * unsupported languages).
 */

import type { Chunker, CodeChunk, SourceDocument } from "./base.js";
import { LineWindowChunker } from "./prose.js";

// Extension → loctx language label. Kept in sync with the Python port so
// Chroma metadata matches across implementations.
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
  ".rb": "ruby",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".kt": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
});

export function detectLanguage(relPath: string): string | null {
  const name = relPath.split("/").at(-1) ?? relPath;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const suffix = name.slice(dot).toLowerCase();
  return LANGUAGE_BY_EXTENSION[suffix] ?? null;
}

export interface CodeChunkerOptions {
  readonly fallback?: Chunker;
}

export class TreeSitterCodeChunker implements Chunker {
  private readonly fallback: Chunker;

  constructor(options: CodeChunkerOptions = {}) {
    this.fallback = options.fallback ?? new LineWindowChunker();
  }

  chunk(document: SourceDocument): CodeChunk[] {
    // TODO: integrate web-tree-sitter + bundled grammars.
    return this.fallback.chunk(document);
  }
}
