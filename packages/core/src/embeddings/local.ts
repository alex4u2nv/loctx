/**
 * Local sentence-embedding provider via @huggingface/transformers (ONNX).
 *
 * The model is loaded lazily on first use. Importing this module is cheap;
 * only when `identity`, `embedDocuments`, or `embedQuery` is called does
 * the transformers runtime get pulled in and the model downloaded/cached.
 */

import type { EmbeddingIdentity } from "../models.js";
import type { EmbeddingProvider } from "./base.js";

export const DEFAULT_LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";

type FeatureExtractionPipeline = (
  texts: string | string[],
  options: { pooling: "mean" | "cls"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[]; tolist(): number[][] }>;

export interface LocalProviderOptions {
  readonly modelName?: string;
  readonly normalize?: boolean;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  public readonly modelName: string;
  public readonly normalize: boolean;

  private pipelineP: Promise<FeatureExtractionPipeline> | null = null;
  private cachedIdentity: EmbeddingIdentity | null = null;

  constructor(options: LocalProviderOptions = {}) {
    this.modelName = options.modelName ?? DEFAULT_LOCAL_MODEL;
    this.normalize = options.normalize ?? true;
  }

  get identity(): EmbeddingIdentity {
    if (this.cachedIdentity === null) {
      throw new Error(
        "EmbeddingIdentity not yet known — call ensureReady() or embedQuery() first.",
      );
    }
    return this.cachedIdentity;
  }

  /** Load the model and produce a probe embedding to learn the dimension. */
  async ensureReady(): Promise<EmbeddingIdentity> {
    if (this.cachedIdentity !== null) return this.cachedIdentity;
    const pipe = await this.getPipeline();
    const probe = await pipe("loctx-init-probe", {
      pooling: "mean",
      normalize: this.normalize,
    });
    const dim = probe.dims.at(-1) ?? probe.data.length;
    this.cachedIdentity = Object.freeze({
      provider: "huggingface-transformers",
      model: this.modelName,
      dimension: dim,
      normalize: this.normalize,
    });
    return this.cachedIdentity;
  }

  async embedDocuments(texts: ReadonlyArray<string>): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureReady();
    const pipe = await this.getPipeline();
    const result = await pipe([...texts], { pooling: "mean", normalize: this.normalize });
    return result.tolist();
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.embedDocuments([text]);
    if (embedding === undefined) {
      throw new Error("Empty embedding result");
    }
    return embedding;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (this.pipelineP !== null) return this.pipelineP;
    this.pipelineP = (async () => {
      // Lazy: keeps the import out of cold-path tooling (typecheck, biome).
      // First call pulls in onnxruntime-node and downloads the model.
      const { pipeline } = (await import("@huggingface/transformers")) as unknown as {
        pipeline: (task: string, model: string) => Promise<FeatureExtractionPipeline>;
      };
      return pipeline("feature-extraction", this.modelName);
    })();
    return this.pipelineP;
  }

  /**
   * Release ONNX session held by the HF pipeline. Without this, exiting Node
   * with a warm pipeline produces "mutex lock failed" on stderr and ties up
   * the bound TCP port for ~10s. We give dispose() 2s to clean up; if it
   * hangs we proceed anyway.
   */
  async dispose(): Promise<void> {
    if (this.pipelineP === null) return;
    const promise = this.pipelineP;
    this.pipelineP = null;
    this.cachedIdentity = null;
    try {
      const pipe = await promise;
      const dispose = (pipe as unknown as { dispose?: () => Promise<void> }).dispose;
      if (typeof dispose !== "function") return;
      await Promise.race([
        dispose.call(pipe),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      // best-effort — keep shutting down even if dispose throws
    }
  }
}
