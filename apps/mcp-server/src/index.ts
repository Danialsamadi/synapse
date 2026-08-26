import { resolveDbPath } from "@synapse/core";
import { runCli } from "@synapse/cli";

// `synapse-os` with no args (or `mcp`) = stdio MCP server, so existing
// `npx -y synapse-os` MCP client configs keep working. Any other first arg
// dispatches to the CLI — same store, env, and write guards.
const argv = process.argv.slice(2);

if (argv.length > 0 && argv[0] !== "mcp") {
  await runCli(argv);
} else {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { MemoryRepository, runDecay } = await import("@synapse/store");
  const { createSynapseMcpServer } = await import("./server.js");

  const repo = new MemoryRepository({ path: resolveDbPath() });
  const server = createSynapseMcpServer(repo);
  // Long-lived hosts (gateways) can keep one process up for weeks; re-run the
  // TTL/decay sweep daily, not just at startup. unref: never holds exit open.
  setInterval(() => runDecay(repo), 24 * 3600 * 1000).unref();
  await server.connect(new StdioServerTransport());
}
