/**
 * Markdown / prompt / skill chunker — splits documents at headings so each
 * chunk carries a meaningful section boundary, not an arbitrary line slice.
 *
 * Behavior:
 *   - Sections delimited by ATX headings (`#`, `##`, `###`, `####`, `#####`,
 *     `######`). The heading line is part of the section it introduces.
 *   - Frontmatter (a `---` YAML block at file start) stays attached to the
 *     first chunk so SKILL.md / blog-post style files keep their metadata
 *     adjacent to the first heading.
 *   - Fenced code blocks (` ``` ` and ` ~~~ `) are opaque — headings inside
 *     a code fence do not split. Critical for skill files that quote code
 *     containing comments like "# heading".
 *   - The chunk's `symbols` carry the heading path (e.g.
 *     `["Setup", "Local install"]`) so FTS5 ranking can use them.
 *   - Documents with no headings fall through to {@link LineWindowChunker}
 *     so config files, plain notes, and `.txt` content still get indexed.
 *   - Sections larger than `maxLines` (default 200) are split into
 *     overlapping windows within the section so embedding inputs stay
 *     bounded.
 */

import { type Chunker, type CodeChunk, chunkShaFor, type SourceDocument } from "./base.js";
import { LineWindowChunker } from "./prose.js";

const FRONTMATTER_DELIMITER = "---";
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^(?:```|~~~)/;
const DEFAULT_MAX_SECTION_LINES = 200;
const DEFAULT_OVERLAP_LINES = 8;

export interface MarkdownChunkerOptions {
  /** Cap a section's line count before splitting it via the line-window fallback. */
  readonly maxSectionLines?: number;
  /** Overlap between split sub-windows of an oversized section. */
  readonly overlapLines?: number;
}

interface PendingSection {
  readonly headingPath: ReadonlyArray<string>;
  readonly startLine: number; // 1-indexed
  readonly lines: string[];
}

export class MarkdownChunker implements Chunker {
  private readonly maxSectionLines: number;
  private readonly windowFallback: LineWindowChunker;

  constructor(options: MarkdownChunkerOptions = {}) {
    this.maxSectionLines = options.maxSectionLines ?? DEFAULT_MAX_SECTION_LINES;
    const overlap = options.overlapLines ?? DEFAULT_OVERLAP_LINES;
    this.windowFallback = new LineWindowChunker({
      windowLines: this.maxSectionLines,
      overlapLines: overlap,
    });
  }

  chunk(document: SourceDocument): CodeChunk[] {
    if (document.content === "") return [];
    const lines = document.content.split(/\r?\n/);
    if (lines.at(-1) === "" && lines.length > 1) lines.pop();
    if (lines.length === 0) return [];

    const sections = this.splitIntoSections(lines);
    if (sections.length === 0) {
      // No headings: fall back to fixed line window so config/plain text
      // still gets indexed somehow.
      return this.windowFallback.chunk(document);
    }

    return sections.flatMap((section) => this.materializeSection(section));
  }

  // ---- section detection ---------------------------------------------

  private splitIntoSections(lines: ReadonlyArray<string>): PendingSection[] {
    const out: PendingSection[] = [];
    const headingStack: string[] = []; // index = depth - 1
    let inFence = false;
    let preambleLines: string[] = [];
    let preambleStart = 1;

    let frontmatterEnd = -1;
    if (lines[0] === FRONTMATTER_DELIMITER) {
      for (let i = 1; i < lines.length; i += 1) {
        if (lines[i] === FRONTMATTER_DELIMITER) {
          frontmatterEnd = i;
          break;
        }
      }
    }

    let i = frontmatterEnd >= 0 ? frontmatterEnd + 1 : 0;
    if (frontmatterEnd >= 0) {
      // Frontmatter rides with the first chunk.
      preambleLines = lines.slice(0, frontmatterEnd + 1);
      preambleStart = 1;
    }

    let current: PendingSection | null = null;

    for (; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (FENCE_RE.test(line)) inFence = !inFence;

      const headingMatch = inFence ? null : HEADING_RE.exec(line);
      if (headingMatch !== null) {
        if (current !== null) out.push(current);

        const depth = (headingMatch[1] ?? "").length;
        const text = (headingMatch[2] ?? "").trim();
        // Trim the heading stack to this level then push the new heading.
        headingStack.length = Math.max(0, depth - 1);
        headingStack[depth - 1] = text;

        current = {
          headingPath: Object.freeze(headingStack.slice(0, depth).filter((h) => h !== "")),
          startLine: i + 1,
          lines: [line],
        };

        // Frontmatter and any pre-heading preamble attach to the first
        // section so users don't lose context.
        if (preambleLines.length > 0) {
          current.lines.unshift(...preambleLines);
          // Adjust startLine to where the preamble began.
          (current as { startLine: number }).startLine = preambleStart;
          preambleLines = [];
        }
      } else if (current !== null) {
        current.lines.push(line);
      } else {
        // Pre-heading preamble that isn't frontmatter — keep collecting in
        // case a heading appears later, or attach to first heading.
        preambleLines.push(line);
      }
    }
    if (current !== null) out.push(current);

    return out;
  }

  // ---- section → CodeChunk[] -----------------------------------------

  private materializeSection(section: PendingSection): CodeChunk[] {
    const lineCount = section.lines.length;
    if (lineCount <= this.maxSectionLines) {
      const content = section.lines.join("\n");
      return [
        {
          startLine: section.startLine,
          endLine: section.startLine + lineCount - 1,
          content,
          kind: kindFor(section.headingPath.length),
          symbols: section.headingPath,
          chunkSha: chunkShaFor(content),
        },
      ];
    }

    // Oversized section: walk the line-window chunker over its body but
    // preserve the heading path on each emitted chunk.
    const sub = this.windowFallback.chunk({
      relPath: "<section>",
      content: section.lines.join("\n"),
      language: "markdown",
    });
    return sub.map((s) => ({
      ...s,
      startLine: section.startLine + s.startLine - 1,
      endLine: section.startLine + s.endLine - 1,
      kind: kindFor(section.headingPath.length),
      symbols: section.headingPath,
    }));
  }
}

function kindFor(depth: number): string {
  // depth 0 means we attached preamble to a chunk that lacked a heading
  // (only possible if section detection was triggered then frontmatter-
  // only file was emitted; treated as `section` for simplicity).
  if (depth === 0) return "section";
  return `section-h${Math.min(depth, 6)}`;
}
