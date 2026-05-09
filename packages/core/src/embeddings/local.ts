/**
 * Local sentence-embedding provider via @huggingface/transformers (ONNX).
 *
 * The model is loaded lazily on first use. Importing this module is cheap;
 * only when `identity`, `embedDocuments`, or `embedQuery` is called does
 * the transformers runtime get pulled in and the model downloaded/cached.
 */

import type { EmbeddingIdentity } from "../models.js";
import { requireOutboundAllowed } from "../network.js";
import type { EmbeddingProvider } from "./base.js";

export const DEFAULT_LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";

type FeatureExtractionPipeline = (
  texts: string | string[],
  options: { pooling: "mean" | "cls"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[]; tolist(): number[][] }>;

export interface ProgressEvent {
  readonly status: string; // "initiate" | "download" | "progress" | "done" | "ready" | ...
  readonly file?: string;
  readonly progress?: number; // 0..100
  readonly loaded?: number; // bytes
  readonly total?: number; // bytes
}

export interface LocalProviderOptions {
  readonly modelName?: string;
  readonly normalize?: boolean;
  /** Called for every HF download/load progress event. Defaults to a tiny
   *  stderr printer that emits one banner the first time a model file
   *  starts downloading and a "ready" line when load completes. Pass
   *  ``() => undefined`` to silence. */
  readonly onProgress?: (event: ProgressEvent) => void;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  public readonly modelName: string;
  public readonly normalize: boolean;

  private pipelineP: Promise<FeatureExtractionPipeline> | null = null;
  private cachedIdentity: EmbeddingIdentity | null = null;
  private readonly onProgress: (event: ProgressEvent) => void;

  constructor(options: LocalProviderOptions = {}) {
    this.modelName = options.modelName ?? DEFAULT_LOCAL_MODEL;
    this.normalize = options.normalize ?? true;
    this.onProgress = options.onProgress ?? defaultProgressLogger();
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
    // The HF cache may already hold the model — but we can't tell from
    // outside the library, and a wrong-cache fallback would silently issue
    // a network call. Gate up front; users who want it run
    // `loctx model download` (or `loctx init`) which sets the allow flag.
    requireOutboundAllowed("model-download");
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
        pipeline: (
          task: string,
          model: string,
          options?: {
            dtype?: string;
            progress_callback?: (event: ProgressEvent) => void;
          },
        ) => Promise<FeatureExtractionPipeline>;
      };
      return pipeline("feature-extraction", this.modelName, {
        // Explicit dtype suppresses HF's "default dtype (fp32) for cpu" notice
        // and makes the choice visible in the loctx config.
        dtype: "fp32",
        progress_callback: this.onProgress,
      });
    })();
    return this.pipelineP;
  }

  /**
   * Release ONNX session held by the HF pipeline. Without this, exiting Node
   * with a warm pipeline produces "mutex lock failed" on stderr (see GH#33).
   * We give dispose() 2s to clean up; if it hangs we proceed anyway.
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

/**
 * Default progress callback: print a one-time "downloading model" banner
 * the first time HF actually fetches a file, then a "ready" line when
 * load completes. Quiet on cache-hit runs (HF emits status="ready"
 * directly without download events).
 */
function defaultProgressLogger(): (event: ProgressEvent) => void {
  let announced = false;
  return (event) => {
    if (!announced && event.status === "download") {
      announced = true;
      console.error("[loctx embeddings] downloading model on first run (~90MB to your HF cache)");
    }
    if (event.status === "ready") {
      console.error("[loctx embeddings] ready");
    }
  };
}
