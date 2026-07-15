import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider } from "@mneme/embeddings";
import { MemoryRepository } from "../memory-repository.js";
import { detectAndResolve } from "./conflicts.js";
import { FakeLlm } from "./llm.js";

async function seed() {
  const repo = new MemoryRepository({ path: ":memory:" });
  const embedder = new HashEmbeddingProvider();
  const mk = async (content: string) => {
    const m = repo.create({ type: "semantic", content, tags: ["location"] });
    const [v] = await embedder.embed([content]);
    if (v) repo.saveEmbedding(m.id, v, embedder.model);
    return m;
  };
  return { repo, embedder, mk };
}

describe("conflict engine", () => {
  it("auto-supersedes: Toronto → Vancouver", async () => {
    const { repo, embedder, mk } = await seed();
    const toronto = await mk("User lives in Toronto");
    const vancouver = await mk("User lives in Vancouver");
    const llm = new FakeLlm(["YES"]);
    const out = await detectAndResolve(repo, embedder, llm, vancouver, "auto_supersede_newest");
    assert.deepEqual(out.superseded, [toronto.id]);
    assert.equal(repo.get(toronto.id)?.status, "superseded");
    assert.equal(repo.get(vancouver.id)?.status, "active");
    const rels = repo.getLinks(vancouver.id).map((l) => l.rel).sort();
    assert.deepEqual(rels, ["contradicts", "supersedes"]);
    repo.close();
  });

  it("manual_only marks both disputed", async () => {
    const { repo, embedder, mk } = await seed();
    const a = await mk("User prefers tabs");
    const b = await mk("User prefers spaces");
    const llm = new FakeLlm(["YES"]);
    const out = await detectAndResolve(repo, embedder, llm, b, "manual_only");
    assert.deepEqual(out.disputed.sort(), [a.id, b.id].sort());
    assert.equal(repo.get(a.id)?.status, "disputed");
    assert.equal(repo.get(b.id)?.status, "disputed");
    repo.close();
  });

  it("no conflict when LLM says NO", async () => {
    const { repo, embedder, mk } = await seed();
    await mk("User lives in Vancouver");
    const other = await mk("User likes Vancouver coffee shops");
    const llm = new FakeLlm(["NO"]);
    const out = await detectAndResolve(repo, embedder, llm, other, "auto_supersede_newest");
    assert.equal(out.conflicts, 0);
    repo.close();
  });
});
