import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider } from "@synapse/embeddings";
import { MemoryRepository, RetrievalService } from "@synapse/store";

async function seeded() {
  const repo = new MemoryRepository({ path: ":memory:" });
  const embedder = new HashEmbeddingProvider();
  const svc = new RetrievalService(repo, embedder);
  const write = async (content: string, entityKey?: string) => {
    const { memory } = repo.createWithEntitySupersede({
      userId: "local",
      type: "semantic" as const,
      content,
      ...(entityKey ? { entityKey } : {}),
    });
    const [v] = await embedder.embed([memory.content]);
    if (v) repo.saveEmbedding(memory.id, v, embedder.model);
    return memory;
  };
  return { repo, svc, write };
}

describe("behavioral: truth shifts over time", () => {
  it("entity update replaces old fact at retrieval time (Acme Corp scenario)", async () => {
    const { repo, svc, write } = await seeded();
    await write("User works at Acme Corp as a product manager", "user.employer");
    const current = await write("User works at Initech as an engineering lead", "user.employer");

    const res = await svc.retrieve({ query: "where does the user work", userId: "local", limit: 5 });
    const contents = res.memories.map((m) => m.content);
    assert.ok(contents.includes(current.content), "current employer must surface");
    assert.ok(!contents.some((c) => c.includes("Acme")), "superseded employer must not surface");
    repo.close();
  });

  it("wrong feedback disputes a memory; stale archives it out of retrieval entirely", async () => {
    const { repo, svc, write } = await seeded();
    const w = await write("User lives in Toronto");
    repo.applyFeedback(w.id, "wrong");

    const res = await svc.retrieve({ query: "where does the user live", userId: "local", limit: 5 });
    assert.ok(!res.memories.some((r) => r.id === w.id), "disputed memory hidden by default");

    const withDisputed = await svc.retrieve({
      query: "where does the user live", userId: "local", limit: 5, includeDisputed: true,
    });
    const hit = withDisputed.memories.find((r) => r.id === w.id);
    assert.ok(hit, "disputed memory visible when explicitly requested");
    assert.match(hit!.qualifier ?? "", /disputed/, "qualifier warns the consumer");

    // stale = retired, not contested: never resurfaces, even with includeDisputed
    const s = await write("User lives in Oakville");
    repo.applyFeedback(s.id, "stale");
    const after = await svc.retrieve({
      query: "where does the user live", userId: "local", limit: 5, includeDisputed: true,
    });
    assert.ok(!after.memories.some((r) => r.id === s.id), "archived memory never surfaces");
    repo.close();
  });

  it("repeated helpful feedback raises confidence; repeated wrong feedback floors it", async () => {
    const { repo, write } = await seeded();
    const good = await write("User prefers TypeScript");
    repo.applyFeedback(good.id, "helpful");
    repo.applyFeedback(good.id, "helpful");
    assert.ok(repo.get(good.id)!.confidence > 0.89);

    const bad = await write("User eats a keto diet");
    repo.applyFeedback(bad.id, "wrong");
    repo.applyFeedback(bad.id, "wrong");
    repo.applyFeedback(bad.id, "wrong");
    assert.ok(repo.get(bad.id)!.confidence <= 0.1);
    repo.close();
  });

  it("entity supersession removes the old fact from the digest", async () => {
    const { repo, svc, write } = await seeded();
    await write("User works at Acme Corp", "user.employer");
    assert.match(svc.digest("local").text, /Acme Corp/);

    await write("User works at Initech", "user.employer");
    const d = svc.digest("local");
    assert.match(d.text, /Initech/);
    assert.doesNotMatch(d.text, /Acme Corp/);
    repo.close();
  });

  it("stale feedback on a high-importance memory removes it from the digest", async () => {
    const { repo, svc } = await seeded();
    const m = repo.create({
      userId: "local", type: "semantic", content: "User is a vim user", importance: 0.9,
    });
    assert.match(svc.digest("local").text, /vim user/);

    repo.applyFeedback(m.id, "stale");
    assert.doesNotMatch(svc.digest("local").text, /vim user/);
    repo.close();
  });
});
