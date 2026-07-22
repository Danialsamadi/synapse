import type { EmbeddingProvider } from "./index.js";

/**
 * Local embeddings via transformers.js (all-MiniLM-L6-v2, 384 dims, quantized).
 * No API key; the ~25MB model downloads once to the HF cache on first use.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model = "local-minilm-l6-v2";
  private pipe: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null =
    null;

  private load() {
    this.pipe ??= import("@huggingface/transformers").then(
      ({ pipeline }) =>
        pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" }) as never,
    );
    return this.pipe;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.load();
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return out.tolist();
  }
}
