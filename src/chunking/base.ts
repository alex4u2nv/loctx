/**
 * Chunker interface and shared chunk types.
 */

import { createHash } from "node:crypto";

export interface SourceDocument {
  readonly relPath: string;
  readonly content: string;
  readonly language: string | null;
}

export interface CodeChunk {
  readonly startLine: number; // 1-indexed
  readonly endLine: number; // 1-indexed inclusive
  readonly content: string;
  readonly kind: string;
  readonly symbols: ReadonlyArray<string>;
  readonly chunkSha: string;
}

export interface Chunker {
  chunk(document: SourceDocument): CodeChunk[];
}

export function chunkShaFor(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}
