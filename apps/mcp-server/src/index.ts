import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryRepository } from "@mneme/store";
import { createMnemeMcpServer } from "./server.js";

// Same DB as the API/CLI — MCP-written memories must be visible everywhere.
const path = process.env.MNEME_DB ?? resolve(process.cwd(), ".mneme", "mneme.db");
mkdirSync(dirname(path), { recursive: true });
const repo = new MemoryRepository({ path });

const server = createMnemeMcpServer(repo);
await server.connect(new StdioServerTransport());
