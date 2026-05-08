import { describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../../src/embeddings/index.js";

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
