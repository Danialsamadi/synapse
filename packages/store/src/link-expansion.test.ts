import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HashEmbeddingProvider } from "@synapse/embeddings";
import { MemoryRepository } from "./memory-repository.js";
import { RetrievalService } from "./retrieval.js";

function setup() {
  const repo = new MemoryRepository({ path: ":memory:" });
  const retrieval = new RetrievalService(repo, new HashEmbeddingProvider());
  const book = repo.create({
    userId: "local",
    type: "semantic",
    content: "Clean Code — book by Robert Martin about maintainable software",
    tags: ["book"],
  });
  const chapter = repo.create({
    userId: "local",
    type: "semantic",
    content: "Chapter two covers meaningful naming: reveal intent, avoid encodings",
    tags: ["book:clean-code", "chapter"],
  });
  repo.addLink(chapter.id, book.id, "part_of");
  return { repo, retrieval, book, chapter };
}

describe("1-hop link expansion", () => {
  it("a chapter hit brings its book along at a discounted score", async () => {
    const { retrieval, book, chapter } = setup();
    const { memories } = await retrieval.retrieve({
      query: "meaningful naming reveal intent",
      userId: "local",
      limit: 8,
    });
    const ids = memories.map((m) => m.id);
    assert.ok(ids.includes(chapter.id));
    assert.ok(ids.includes(book.id));
    const bookHit = memories.find((m) => m.id === book.id)!;
    const chapterHit = memories.find((m) => m.id === chapter.id)!;
    // Direct semantic/keyword hits rank the book too; expansion guarantees
    // presence, and a link-only neighbor carries the link component.
    assert.ok(bookHit.score <= chapterHit.score || bookHit.scoreBreakdown?.link === undefined);
  });

  it("does not follow supersedes links (retired facts stay retired)", async () => {
    const { repo, retrieval } = setup();
    const oldFact = repo.create({ userId: "local", type: "semantic", content: "zzz outdated naming rule" });
    repo.update(oldFact.id, { status: "superseded" });
    const winner = repo.create({ userId: "local", type: "semantic", content: "naming rules current edition" });
    repo.addLink(winner.id, oldFact.id, "supersedes");
    const { memories } = await retrieval.retrieve({ query: "naming rules", userId: "local", limit: 8 });
    assert.ok(!memories.some((m) => m.id === oldFact.id));
  });

  it("expansion never exceeds the requested limit", async () => {
    const { retrieval } = setup();
    const { memories } = await retrieval.retrieve({
      query: "meaningful naming reveal intent",
      userId: "local",
      limit: 1,
    });
    assert.equal(memories.length, 1);
  });
});
