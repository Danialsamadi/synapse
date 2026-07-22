import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDbPath } from "@synapse/core";
import { MemoryRepository } from "@synapse/store";
import { createSynapseMcpServer } from "./server.js";

// Real semantic embeddings by default; SYNAPSE_EMBED_PROVIDER=hash|openai overrides.
process.env.SYNAPSE_EMBED_PROVIDER ??= "local";

const repo = new MemoryRepository({ path: resolveDbPath() });

const server = createSynapseMcpServer(repo);
await server.connect(new StdioServerTransport());
