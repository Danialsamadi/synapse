import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryRepository } from "@synapse/store";
import { createSynapseMcpServer } from "./server.js";

// MCP clients launch this process with an arbitrary cwd, so a cwd-relative
// default scatters DBs. Default to a stable per-user path; SYNAPSE_DB overrides
// (set it to the repo's .synapse/synapse.db to share with the API/CLI).
const path = process.env.SYNAPSE_DB ?? join(homedir(), ".synapse", "synapse.db");
mkdirSync(dirname(path), { recursive: true });
const repo = new MemoryRepository({ path });

const server = createSynapseMcpServer(repo);
await server.connect(new StdioServerTransport());
