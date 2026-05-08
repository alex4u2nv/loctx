/**
 * Embedding provider interface and an in-process fake for tests.
 */

import { createHash } from "node:crypto";
import type { EmbeddingIdentity } from "../models.js";

export interface EmbeddingProvider {
  /** Stable identifier for the embedding model + options. */
  readonly identity: EmbeddingIdentity;
  embedDocuments(texts: ReadonlyArray<string>): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  /**
   * Optional warmup hook. Lazy providers (LocalEmbeddingProvider) load the
   * model on first call so they implement this. In-process providers
   * (FakeEmbeddingProvider) leave it undefined; callers should `?.()` it.
   */
  ensureReady?(): Promise<EmbeddingIdentity>;
  /**
   * Optional teardown hook. Implementations holding native resources
   * (e.g. ONNX sessions) release them here. Best-effort: callers should
   * tolerate failures and time-outs and continue shutting down.
   */
  dispose?(): Promise<void>;
}

export interface FakeProviderOptions {
  readonly dimension?: number;
  readonly normalize?: boolean;
}

/**
 * Deterministic fake — hashes text into a fixed-length vector.
 *
 * Cheap to construct, no model download. Same input produces the same vector
 * across processes, so tests can assert on similarity.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  public readonly identity: EmbeddingIdentity;

  constructor(options: FakeProviderOptions = {}) {
    this.identity = Object.freeze({
      provider: "fake",
      model: "hash",
      dimension: options.dimension ?? 16,
      normalize: options.normalize ?? true,
    });
  }

  async embedDocuments(texts: ReadonlyArray<string>): Promise<number[][]> {
    return texts.map((text) => this.embed(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  private embed(text: string): number[] {
    const digest = createHash("sha256").update(text, "utf-8").digest();
    const dim = this.identity.dimension;
    const repeats = Math.ceil(dim / digest.length);
    const buf = Buffer.concat(new Array(repeats).fill(digest)).subarray(0, dim);
    const vec = Array.from(buf, (b) => (b - 128) / 128);
    if (!this.identity.normalize) return vec;
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}
