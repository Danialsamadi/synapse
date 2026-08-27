import type { EmbeddingProvider } from "./index.js";

export interface OpenAiEmbeddingOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: OpenAiEmbeddingOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.apiKey = opts.apiKey ?? "";
    this.model = opts.model ?? "text-embedding-3-small";
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 404/405 on /embeddings usually means the base URL is a chat-only
      // router/proxy — steer to an endpoint that actually serves embeddings.
      const hint =
        res.status === 404 || res.status === 405
          ? " Hint: this base URL may not serve /embeddings (chat-completion routers don't). " +
            "Point SYNAPSE_EMBED_BASE_URL at an embeddings-capable endpoint (e.g. Ollama: http://localhost:11434/v1 with SYNAPSE_EMBED_MODEL=nomic-embed-text)."
          : "";
      throw new Error(`OpenAI embedding request failed (${res.status}): ${body}${hint}`);
    }
    const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
