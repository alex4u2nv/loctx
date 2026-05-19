/**
 * Local sentence-embedding provider via @huggingface/transformers (ONNX).
 *
 * The model is loaded lazily on first use. Importing this module is cheap;
 * only when `identity`, `embedDocuments`, or `embedQuery` is called does
 * the transformers runtime get pulled in and the model downloaded/cached.
 */

import type { EmbeddingIdentity } from "../models.js";
import { requireOutboundAllowed } from "../network.js";
import { isModelTrusted } from "../trusted-models.js";
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
  /**
   * loctx data dir. When set, ensureReady() consults the trusted-models
   * store at `<dataDir>/trusted-models.json` and skips the network gate
   * for models the user has previously downloaded via `loctx model
   * download`. Without it, every load goes through the gate.
   */
  readonly dataDir?: string;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  public readonly modelName: string;
  public readonly normalize: boolean;

  private pipelineP: Promise<FeatureExtractionPipeline> | null = null;
  private cachedIdentity: EmbeddingIdentity | null = null;
  private readonly onProgress: (event: ProgressEvent) => void;
  private readonly dataDir: string | null;

  constructor(options: LocalProviderOptions = {}) {
    this.modelName = options.modelName ?? DEFAULT_LOCAL_MODEL;
    this.normalize = options.normalize ?? true;
    this.onProgress = options.onProgress ?? defaultProgressLogger();
    this.dataDir = options.dataDir ?? null;
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
    // outside the library. Two-stage check:
    //   1. If the user has previously downloaded this model via
    //      `loctx model download`, the trusted-models store records it
    //      and we skip the gate. The earlier explicit consent stands;
    //      no need to re-flip the per-process allow flag for every
    //      daemon / index / search call.
    //   2. Otherwise require an in-process allow flag (set by
    //      `loctx model download` itself + the init wizard).
    const trusted = this.dataDir !== null && isModelTrusted(this.dataDir, this.modelName);
    if (!trusted) requireOutboundAllowed("model-download", this.modelName);
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
   *
   * Timeout is 5s in normal operation and 30s when `LOCTX_LOG=debug` so
   * the operator gets a fuller picture during teardown debugging.
   * Either bound is generous enough for healthy disposes (typically
   * tens of ms) but short enough that a hung session doesn't pin
   * shutdown. We log when the timeout actually fires so a quietly
   * accumulating leak becomes visible (#213).
   */
  async dispose(): Promise<void> {
    if (this.pipelineP === null) return;
    const promise = this.pipelineP;
    this.pipelineP = null;
    this.cachedIdentity = null;
    const timeoutMs = process.env["LOCTX_LOG"] === "debug" ? 30_000 : 5_000;
    try {
      const pipe = await promise;
      const dispose = (pipe as unknown as { dispose?: () => Promise<void> }).dispose;
      if (typeof dispose !== "function") return;
      let timedOut = false;
      await Promise.race([
        dispose.call(pipe),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs),
        ),
      ]);
      if (timedOut) {
        console.error(
          `[embeddings] pipeline.dispose() hung past ${timeoutMs}ms; abandoning. ONNX session may leak until process exit.`,
        );
      }
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
  // Stderr only. The stdio MCP transport (`loctx-mcp`) treats stdout as
  // the JSONRPC channel — any console.log here would corrupt the
  // protocol and the agent would drop the connection mid-search. CLI
  // and daemon both prefer stderr for operational logs anyway.
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
