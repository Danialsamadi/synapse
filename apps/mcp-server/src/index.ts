import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryRepository } from "@mneme/store";
import { createMnemeMcpServer } from "./server.js";

// MCP clients launch this process with an arbitrary cwd, so a cwd-relative
// default scatters DBs. Default to a stable per-user path; MNEME_DB overrides
// (set it to the repo's .mneme/mneme.db to share with the API/CLI).
const path = process.env.MNEME_DB ?? join(homedir(), ".mneme", "mneme.db");
mkdirSync(dirname(path), { recursive: true });
const repo = new MemoryRepository({ path });

const server = createMnemeMcpServer(repo);
await server.connect(new StdioServerTransport());
