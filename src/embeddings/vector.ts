/** Small vector helpers for embedding-based classification. */

/** Cosine similarity. Assumes finite numbers; returns 0 for a zero vector. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** L2-normalize a vector to unit length (returns a copy). */
export function normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return [...v];
  return v.map((x) => x / norm);
}

/** Mean of several vectors, then L2-normalized — the centroid/prototype. */
export function meanNormalize(vecs: number[][]): number[] {
  if (vecs.length === 0) return [];
  const dim = vecs[0]?.length ?? 0;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] as number) + (v[i] ?? 0);
  }
  for (let i = 0; i < dim; i++) sum[i] = (sum[i] as number) / vecs.length;
  return normalize(sum);
}
