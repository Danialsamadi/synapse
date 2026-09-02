import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MemoryRepository } from "@synapse/store";
import { resolveDbPath } from "@synapse/core";
import { createSynapseMcpServer, type SynapsePrincipal } from "./server.js";

type TokenConfig = Record<string, SynapsePrincipal>;

function loadTokens(): TokenConfig {
  const raw = process.env.SYNAPSE_TOKENS_JSON;
  if (!raw) throw new Error("SYNAPSE_TOKENS_JSON is required for remote MCP");
  const parsed = JSON.parse(raw) as Record<string, SynapsePrincipal>;
  const out: TokenConfig = {};
  for (const [token, principal] of Object.entries(parsed)) {
    if (!token || !principal?.userId || !Array.isArray(principal.teamIds)) throw new Error("Invalid SYNAPSE_TOKENS_JSON");
    out[token] = { userId: principal.userId, teamIds: [...new Set(principal.teamIds)] };
  }
  if (!Object.keys(out).length) throw new Error("SYNAPSE_TOKENS_JSON must contain at least one token");
  return out;
}

function bearerToken(value: string | undefined): string | undefined {
  if (!value?.startsWith("Bearer ")) return undefined;
  const token = value.slice(7).trim();
  return token.length > 0 && token.length <= 4096 ? token : undefined;
}

export function createRemoteApp(repo = new MemoryRepository({ path: resolveDbPath() }), tokens = loadTokens()) {
  const app = new Hono<{ Variables: { principal: SynapsePrincipal } }>();
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    const token = bearerToken(c.req.header("Authorization"));
    const principal = token ? tokens[token] : undefined;
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", principal);
    await next();
  });
  app.get("/health", (c) => c.json({ ok: true, service: "synapse-remote-mcp" }));
  app.all("/mcp", async (c) => {
    if (c.req.method !== "POST" && c.req.method !== "GET" && c.req.method !== "DELETE") return c.json({ error: "method_not_allowed" }, 405);
    const principal = c.get("principal");
    const server = createSynapseMcpServer(repo, principal);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    return response;
  });
  return { app, repo };
}

if (process.argv[1]?.endsWith("remote.ts")) {
  const { app } = createRemoteApp();
  const port = Number(process.env.PORT ?? 8787);
  const hostname = process.env.SYNAPSE_HOST ?? "0.0.0.0";
  serve({ fetch: app.fetch, port, hostname }, () => console.log(`synapse remote MCP listening on ${hostname}:${port}`));
}
