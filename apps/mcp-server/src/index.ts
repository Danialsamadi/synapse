import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDbPath } from "@synapse/core";
import { MemoryRepository } from "@synapse/store";
import { createSynapseMcpServer } from "./server.js";

const repo = new MemoryRepository({ path: resolveDbPath() });

const server = createSynapseMcpServer(repo);
await server.connect(new StdioServerTransport());
