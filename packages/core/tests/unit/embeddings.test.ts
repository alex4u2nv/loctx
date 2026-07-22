import { describe, expect, it } from "vitest";
import {
  EMBEDDING_REGISTRY,
  FakeEmbeddingProvider,
  findModel,
  LocalEmbeddingProvider,
} from "../../src/embeddings/index.js";

describe("FakeEmbeddingProvider", () => {
  it("identity is stable", () => {
    const p = new FakeEmbeddingProvider({ dimension: 16 });
    expect(p.identity.dimension).toBe(16);
    expect(p.identity.provider).toBe("fake");
  });

  it("is deterministic", async () => {
    const p = new FakeEmbeddingProvider({ dimension: 8 });
    const a = await p.embedQuery("hello");
    const b = await p.embedQuery("hello");
    expect(a).toEqual(b);
  });

  it("distinguishes inputs", async () => {
    const p = new FakeEmbeddingProvider({ dimension: 8 });
    expect(await p.embedQuery("alpha")).not.toEqual(await p.embedQuery("beta"));
  });

  it("normalizes by default", async () => {
    const p = new FakeEmbeddingProvider({ dimension: 16 });
    const v = await p.embedQuery("normalize me");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("batch matches individual calls", async () => {
    const p = new FakeEmbeddingProvider({ dimension: 8 });
    const batch = await p.embedDocuments(["a", "b", "c"]);
    const each = [await p.embedQuery("a"), await p.embedQuery("b"), await p.embedQuery("c")];
    expect(batch).toEqual(each);
  });
});

describe("EMBEDDING_REGISTRY metadata", () => {
  it("every entry declares license, pooling, and dtype", () => {
    for (const m of EMBEDDING_REGISTRY) {
      expect(m.license, m.name).toMatch(/\S/);
      expect(["mean", "cls"], m.name).toContain(m.pooling);
      expect(m.dtype, m.name).toMatch(/\S/);
    }
  });

  it("gte-modernbert is CLS-pooled 8-bit apache (2025-gen entry)", () => {
    const m = findModel("Alibaba-NLP/gte-modernbert-base");
    expect(m).not.toBeNull();
    expect(m?.pooling).toBe("cls");
    expect(m?.dtype).toBe("q8");
    expect(m?.license).toBe("apache-2.0");
    expect(m?.dimension).toBe(768);
  });

  it("embeddinggemma carries asymmetric task prefixes and the gemma license", () => {
    const m = findModel("onnx-community/embeddinggemma-300m-ONNX");
    expect(m).not.toBeNull();
    expect(m?.queryPrefix).toBe("task: search result | query: ");
    expect(m?.documentPrefix).toBe("title: none | text: ");
    expect(m?.license).toBe("gemma");
    expect(m?.pooling).toBe("mean");
  });
});

describe("LocalEmbeddingProvider registry resolution", () => {
  // Constructor-level only: no model download happens until embed/ensureReady.
  it("resolves pooling and dtype from the catalog entry", () => {
    const p = new LocalEmbeddingProvider({ modelName: "Alibaba-NLP/gte-modernbert-base" });
    expect(p.pooling).toBe("cls");
    expect(p.dtype).toBe("q8");
  });

  it("falls back to mean/fp32 for off-catalog model names", () => {
    const p = new LocalEmbeddingProvider({ modelName: "someone/custom-model" });
    expect(p.pooling).toBe("mean");
    expect(p.dtype).toBe("fp32");
  });

  it("default model keeps the historical mean/fp32 behaviour", () => {
    const p = new LocalEmbeddingProvider();
    expect(p.modelName).toBe("Xenova/all-MiniLM-L6-v2");
    expect(p.pooling).toBe("mean");
    expect(p.dtype).toBe("fp32");
  });

  it("applies queryPrefix to queries and documentPrefix to documents — never crossed", async () => {
    const p = new LocalEmbeddingProvider({
      modelName: "onnx-community/embeddinggemma-300m-ONNX",
    });
    // Inject a capture pipeline so no model download happens. This reaches
    // into privates deliberately: the prefix routing is the behaviour under
    // test and there's no seam for it short of a real ONNX session.
    const seen: string[] = [];
    const fakePipe = async (texts: string | string[], opts: { pooling: string }) => {
      const arr = Array.isArray(texts) ? texts : [texts];
      seen.push(...arr.map((t) => `${opts.pooling}|${t}`));
      return {
        data: new Float32Array(arr.length * 4),
        dims: [arr.length, 4],
        tolist: () => arr.map(() => [0, 0, 0, 0]),
      };
    };
    const priv = p as unknown as { pipelineP: unknown; cachedIdentity: unknown };
    priv.pipelineP = Promise.resolve(fakePipe);
    priv.cachedIdentity = Object.freeze({
      provider: "huggingface-transformers",
      model: p.modelName,
      dimension: 4,
      normalize: true,
    });

    await p.embedDocuments(["const x = 1"]);
    await p.embedQuery("where is x defined");
    expect(seen).toEqual([
      "mean|title: none | text: const x = 1",
      "mean|task: search result | query: where is x defined",
    ]);
  });
});
