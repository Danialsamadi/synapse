/**
 * Thin consumer — Week 2 fully wires tool-calling.
 * For now: scripted write + retrieve against a running API.
 */
import { MnemeClient } from "@mneme/sdk";

const baseUrl = process.env.MNEME_URL ?? "http://localhost:8787";

async function main(): Promise<void> {
  const client = new MnemeClient({ baseUrl });
  console.log("Demo agent (scripted) →", baseUrl);

  const created = await client.createMemory({
    type: "procedural",
    content: "Prefer concise bullet answers with tradeoffs.",
    tags: ["style"],
    importance: 0.9,
  });
  console.log("wrote", created.id);

  const hit = await client.retrieve({
    query: "How should you answer me?",
    limit: 5,
  });
  console.log("retrieve", JSON.stringify(hit, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
