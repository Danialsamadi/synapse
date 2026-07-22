import { SynapseClient, MEMORY_TOOLS, executeMemoryTool } from "@synapse/sdk";

const baseUrl = process.env.SYNAPSE_URL ?? "http://localhost:8787";

interface SimulatedMessage {
  role: "user";
  content: string;
}

const messages: SimulatedMessage[] = [
  { role: "user", content: "I just moved to Vancouver last month." },
  { role: "user", content: "I prefer TypeScript over JavaScript." },
  { role: "user", content: "Where did I just move to?" },
];

function llmDecideTools(content: string): { name: string; args: Record<string, unknown> }[] {
  const lower = content.toLowerCase();
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];

  if (lower.includes("move") || lower.includes("prefer") || lower.includes("like") || lower.includes("love")) {
    toolCalls.push({
      name: "memory_write",
      args: {
        type: lower.includes("prefer") || lower.includes("like") ? "procedural" : "episodic",
        content,
        importance: 0.8,
      },
    });
  }

  if (lower.includes("?") || lower.includes("what") || lower.includes("where") || lower.includes("who")) {
    toolCalls.push({
      name: "memory_retrieve",
      args: { query: content, limit: 5 },
    });
  }

  return toolCalls;
}

async function main(): Promise<void> {
  const client = new SynapseClient({ baseUrl });
  console.log(`Demo agent (tool-calling loop) → ${baseUrl}\n`);

  for (const msg of messages) {
    console.log(`user: ${msg.content}`);
    const toolCalls = llmDecideTools(msg.content);

    for (const call of toolCalls) {
      console.log(`  → tool: ${call.name}`);
      const result = await executeMemoryTool(client, call.name, call.args);
      if (call.name === "memory_retrieve") {
        const retrieved = result as { memories: { score: number; content: string }[] };
        for (const m of retrieved.memories) {
          console.log(`    [${m.score.toFixed(2)}] ${m.content}`);
        }
      } else {
        console.log(`    stored: ${(result as { id: string }).id}`);
      }
    }
    console.log();
  }

  console.log("--- Memory Inspector ---");
  console.log(`GET ${baseUrl}/v1/inspector`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
