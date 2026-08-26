export interface EmbeddingProvider {
  readonly model: string;
  /**
   * Whether vectors from this provider carry meaning. Undefined = true (real
   * providers). When false, retrieval must not rank by vector similarity and
   * write-time semantic dedup must not run — the scores would be noise.
   */
  readonly semantic?: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

/** Deterministic char-frequency embeddings: zero deps, zero network — and zero
 *  semantics. Non-semantic by default; tests that use it as a stand-in for a
 *  real model pass `{ semantic: true }` to opt back into vector ranking. */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = "hash-embed-v0";
  readonly semantic: boolean;
  private readonly dims: number;

  constructor(dims = 32, opts: { semantic?: boolean } = {}) {
    this.dims = dims;
    this.semantic = opts.semantic ?? false;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    const normalized = text.toLowerCase();
    for (let i = 0; i < normalized.length; i++) {
      const code = normalized.charCodeAt(i);
      v[i % this.dims]! += (code % 13) / 13;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export { OpenAiEmbeddingProvider, type OpenAiEmbeddingOptions } from "./openai.js";
export { LocalEmbeddingProvider } from "./local.js";
