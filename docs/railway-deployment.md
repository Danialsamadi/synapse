# Railway Deployment: Synapse Remote MCP

## Scope and security

The remote entrypoint is `apps/mcp-server/src/remote.ts`. It exposes `/mcp` using the official MCP SDK Web Standard Streamable HTTP transport behind Hono. Every request requires a Bearer token and the token is mapped server-side to `{ userId, teamIds }`. Caller-supplied identity fields are not used to select a principal.

Railway must have a persistent volume mounted at `/data`. Set `SYNAPSE_DB=/data/synapse.db`; without a volume, SQLite data will be lost on redeploy. Do not expose the container port directly through another public route and do not publish the SQLite file.

## Deploy

1. Push this branch to a GitHub repository you control.
2. Create a Railway project and deploy the repository as a service.
3. Confirm Railway detects `Dockerfile` or select it explicitly.
4. Add a persistent volume mounted at `/data`.
5. Set the variables from `.env.example` in Railway Variables. The only mandatory remote-MCP secret is `SYNAPSE_TOKENS_JSON`.
6. Generate a Railway domain or attach a domain you control. The public endpoint will be `https://<domain>/mcp`.
7. Verify `https://<domain>/health` returns `{ "ok": true }` and test the MCP endpoint with an authenticated MCP client.

## Token mapping

Generate high-entropy opaque tokens outside Git and store them only as a Railway secret variable:

```json
{
  "TOKEN_A_VALUE": { "userId": "user_a", "teamIds": ["team_1"] },
  "TOKEN_B_VALUE": { "userId": "user_b", "teamIds": ["team_1"] },
  "TOKEN_C_VALUE": { "userId": "user_c", "teamIds": [] }
}
```

Private memories are visible only to their owner. Team memories are visible only to members of the listed team. A missing or invalid token returns `401`; a memory outside the caller's visibility is treated as not found by the MCP tool layer.

## Manus

In **Settings → Integrations → Custom MCP Servers → Add Server**, enter:

```text
Server name: Synapse Central Memory
Server URL: https://<railway-domain>/mcp
Authentication: Bearer token
Token: the token assigned to this Manus account
```

Use a different token for every Manus account. Add an instruction/skill for each Manus account: call `memory_digest` at session start; call `memory_retrieve` before answering questions about stored facts; call `memory_write` for durable new facts; call `memory_feedback` when a memory is stale or wrong. MCP tool descriptions cannot force a tool call by themselves.

## Hermes

Configure Hermes with a remote Streamable HTTP MCP server using its HTTP MCP configuration fields. The equivalent request authorization header is:

```http
Authorization: Bearer TOKEN_A_VALUE
```

If the Hermes build supports only stdio MCP servers, run a local authenticated bridge that connects to the Railway URL; do not copy the shared SQLite database to the client. Configure the same session-start digest instruction.

## Backups

Railway volume persistence is not a complete backup. Run a scheduled job or external backup process that copies the live SQLite database using Synapse's online backup command to encrypted storage outside Git. Retain multiple daily generations and periodically restore to a separate test database. Never restore over a live database.

## Operational checks

- `/health` works without exposing memory data.
- `/mcp` returns `401` without a Bearer token.
- Two tokens list the same tools but cannot read each other's private memories.
- Same-team tokens can read team memories; outside-team tokens cannot.
- Railway volume is mounted at `/data` and survives a redeploy.
- Logs contain no authorization headers or memory content.

## Required user inputs for actual deployment

The implementation can be built and tested without account access. Actual GitHub push and Railway deployment require the user to provide or perform only the account-level actions listed in the final task response: repository write access or a destination repository, Railway project/service access, and the desired domain if a custom domain is required. Never send tokens in chat or commit them.
