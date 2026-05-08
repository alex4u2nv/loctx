/**
 * Line-window chunker for prose, configs, and unsupported languages.
 */

import { type Chunker, type CodeChunk, type SourceDocument, chunkShaFor } from "./base.js";

export interface LineWindowOptions {
  readonly windowLines?: number;
  readonly overlapLines?: number;
}

export class LineWindowChunker implements Chunker {
  public readonly windowLines: number;
  public readonly overlapLines: number;

  constructor(options: LineWindowOptions = {}) {
    this.windowLines = options.windowLines ?? 60;
    this.overlapLines = options.overlapLines ?? 10;
    if (this.windowLines <= 0) {
      throw new Error("windowLines must be positive");
    }
    if (this.overlapLines < 0 || this.overlapLines >= this.windowLines) {
      throw new Error("overlapLines must be in [0, windowLines)");
    }
  }

  chunk(document: SourceDocument): CodeChunk[] {
    const lines = document.content.split(/\r?\n/);
    if (document.content === "") return [];
    if (lines.at(-1) === "" && lines.length > 1) lines.pop();
    if (lines.length === 0) return [];

    const step = this.windowLines - this.overlapLines;
    const chunks: CodeChunk[] = [];
    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(start + this.windowLines, lines.length);
      const content = lines.slice(start, end).join("\n");
      chunks.push({
        startLine: start + 1,
        endLine: end,
        content,
        kind: "window",
        symbols: Object.freeze([]),
        chunkSha: chunkShaFor(content),
      });
      if (end >= lines.length) break;
    }
    return chunks;
  }
}
