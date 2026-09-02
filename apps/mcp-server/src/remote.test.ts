import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryRepository } from "@synapse/store";
import { createRemoteApp } from "./remote.js";

describe("remote MCP authentication", () => {
  it("rejects unauthenticated requests and accepts a mapped principal", async () => {
    const repo = new MemoryRepository({ path: ":memory:" });
    const { app } = createRemoteApp(repo, { token_a: { userId: "user_a", teamIds: ["team_1"] } });
    const denied = await app.request("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }), headers: { "content-type": "application/json" } });
    assert.equal(denied.status, 401);
    const health = await app.request("/health", { headers: { authorization: "Bearer token_a" } });
    assert.equal(health.status, 200);
    repo.close();
  });
});
