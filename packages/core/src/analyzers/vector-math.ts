/**
 * Small vector helpers shared by the embedding-derived analyzers
 * (semantic near-duplicates #523, cohesion #524). Extracted at the
 * second byte-identical copy.
 */

/** L2-normalize into a Float32Array; null for empty or zero-norm vectors. */
export function toUnit(vector: ArrayLike<number>): Float32Array | null {
  if (vector.length === 0) return null;
  let normSq = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const v = vector[i] as number;
    normSq += v * v;
  }
  if (normSq === 0 || !Number.isFinite(normSq)) return null;
  const inv = 1 / Math.sqrt(normSq);
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = (vector[i] as number) * inv;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
