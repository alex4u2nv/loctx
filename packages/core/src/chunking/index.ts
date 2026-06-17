/**
 * Chunking entry points. Top-level `chunkFile()` selects strategy by extension.
 */

import { type Chunker, type CodeChunk, chunkShaFor, type SourceDocument } from "./base.js";
import { detectLanguage, LANGUAGE_BY_EXTENSION, TreeSitterCodeChunker } from "./code.js";
import { MarkdownChunker } from "./markdown.js";
import { LineWindowChunker } from "./prose.js";

export {
  type Chunker,
  type CodeChunk,
  chunkShaFor,
  detectLanguage,
  LANGUAGE_BY_EXTENSION,
  LineWindowChunker,
  MarkdownChunker,
  type SourceDocument,
  TreeSitterCodeChunker,
};

const TREE_SITTER_CHUNKER = new TreeSitterCodeChunker();
const MARKDOWN_CHUNKER = new MarkdownChunker();

/**
 * Chunk a file by relative path + content. Routes by extension:
 *   - `.md` / `.mdx` / `.markdown` / `.mkd` → MarkdownChunker (section-aware)
 *   - tree-sitter languages (.py, .js, .ts, .tsx, .go, .rs, .java) → AST chunker
 *   - everything else → line-window fallback (inside the AST chunker)
 */
export function chunkFile(relPath: string, content: string): CodeChunk[] {
  const language = detectLanguage(relPath);
  if (language === "markdown") {
    return MARKDOWN_CHUNKER.chunk({ relPath, content, language });
  }
  return TREE_SITTER_CHUNKER.chunk({ relPath, content, language });
}
