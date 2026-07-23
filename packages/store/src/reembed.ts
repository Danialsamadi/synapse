import type { EmbeddingProvider } from "@synapse/embeddings";
import type { MemoryRepository } from "./memory-repository.js";

/**
 * Re-embeds every memory with the current provider. Run after switching
 * embedding provider or model, so old vectors don't silently score 0.
 */
export async function reembedAll(
  repo: MemoryRepository,
  embedder: EmbeddingProvider,
  onProgress?: (done: number, total: number) => void,
): Promise<{ total: number; reembedded: number }> {
  const all = repo.listAllForReembed();
  const BATCH = 32;
  let done = 0;
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const vectors = await embedder.embed(batch.map((m) => m.content));
    batch.forEach((m, j) => {
      const v = vectors[j];
      if (v) repo.replaceEmbedding(m.id, v, embedder.model);
    });
    done += batch.length;
    onProgress?.(done, all.length);
  }
  repo.addAudit("job", JSON.stringify({ kind: "reembed", reembedded: done, model: embedder.model }));
  return { total: all.length, reembedded: done };
}
