/**
 * Chunking entry points. Top-level `chunkFile()` selects strategy by extension.
 */

import { type Chunker, type CodeChunk, type SourceDocument, chunkShaFor } from "./base.js";
import { LANGUAGE_BY_EXTENSION, TreeSitterCodeChunker, detectLanguage } from "./code.js";
import { LineWindowChunker } from "./prose.js";

export {
  type Chunker,
  type CodeChunk,
  type SourceDocument,
  chunkShaFor,
  LANGUAGE_BY_EXTENSION,
  LineWindowChunker,
  TreeSitterCodeChunker,
  detectLanguage,
};

const DEFAULT_CHUNKER = new TreeSitterCodeChunker();

/** Chunk a file by relative path + content. AST when available, line-window otherwise. */
export function chunkFile(relPath: string, content: string): CodeChunk[] {
  return DEFAULT_CHUNKER.chunk({
    relPath,
    content,
    language: detectLanguage(relPath),
  });
}
