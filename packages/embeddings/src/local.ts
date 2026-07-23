import type { EmbeddingProvider } from "./index.js";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Local embeddings via transformers.js (default all-MiniLM-L6-v2, 384 dims,
 * quantized). No API key; the model downloads once to the HF cache on first
 * use. Any HF feature-extraction ONNX model id works (e.g. Xenova/bge-small-en-v1.5).
 * After changing models, run `synapse reembed` so stored vectors match.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly modelId: string;
  private pipe: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null =
    null;

  constructor(modelId = DEFAULT_MODEL) {
    this.modelId = modelId;
    this.model = `local:${modelId}`;
  }

  private load() {
    this.pipe ??= import("@huggingface/transformers").then(
      ({ pipeline }) =>
        pipeline("feature-extraction", this.modelId, { dtype: "q8" }) as never,
    );
    return this.pipe;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.load();
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return out.tolist();
  }
}
