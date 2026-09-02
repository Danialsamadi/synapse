# Synapse for Manus: Deployment Runbook

## Current readiness

**Status: Needs Changes / Blocked for production deployment.** The repository is healthy as a local single-user memory service, but it is not safe to expose as a shared multi-user service. No public deployment was made because this session does not have a VPS, domain, DNS access, or deployment credentials.

## Recommended production shape

Use a small Linux VPS or another always-on Node.js host with:

- Node.js 20 or newer.
- Synapse running as a non-root service account.
- SQLite stored on a private filesystem with WAL mode enabled.
- A reverse proxy that terminates HTTPS and forwards only `/mcp` to the Node process.
- Firewall rules allowing HTTPS only; do not expose SQLite, the Node port, Inspector, or administrative routes publicly.
- Encrypted daily backups retained outside the Git repository.

For one to ten accounts and modest memory volume, SQLite is appropriate after the authorization changes. WAL and a busy timeout are already present in the upstream repository. PostgreSQL is not required for the stated scale unless write concurrency or operational requirements grow substantially.

## Required environment variables

The final implementation should use a secret-managed environment, not committed credentials:

```dotenv
NODE_ENV=production
PORT=8787
SYNAPSE_DB=/var/lib/synapse/synapse.db
SYNAPSE_HOST=127.0.0.1
SYNAPSE_EMBED_PROVIDER=hash
SYNAPSE_TOKEN_FILE=/etc/synapse/tokens.json
SYNAPSE_TEAM_FILE=/etc/synapse/teams.json
SYNAPSE_RATE_LIMIT_PER_MINUTE=120
```

The token and team files must be owned by the service account, mode `0600`, and excluded from Git and backups unless the backup is encrypted. Prefer a secret manager when the host provides one.

## Token-to-principal configuration

The service must map each opaque bearer token to an identity server-side:

```json
{
  "tokens": {
    "<token-a>": { "userId": "user_a", "teamIds": ["team_1"] },
    "<token-b>": { "userId": "user_b", "teamIds": ["team_1"] },
    "<token-c>": { "userId": "user_c", "teamIds": [] }
  }
}
```

Do not put these values in the repository, URL, logs, issue tracker, or chat. Rotate tokens by replacing the server-side mapping and updating the corresponding Manus connector.

## HTTPS and reverse proxy

Terminate TLS at a managed HTTPS provider or a reverse proxy such as Caddy/Nginx with an automatically renewed certificate. The public Manus URL should be:

```text
https://memory.example.com/mcp
```

Forward to `http://127.0.0.1:8787/mcp`. Apply HSTS, `X-Content-Type-Options: nosniff`, a strict request body limit, access logs without authorization headers, and a rate limit. Keep `/inspector` disabled or bound to localhost in production.

## Manus setup after deployment

In Manus, open **Settings → Integrations → Custom MCP Servers → Add Server** and enter:

| Field | Value |
|---|---|
| Server name | `Synapse Central Memory` |
| Server URL | `https://memory.example.com/mcp` |
| Authentication | Bearer token or API key, matching the deployed gateway |
| Token | The credential assigned to that Manus account |

Run the connection test and confirm that the expected memory tools are listed. Configure one connector credential per Manus account; never reuse a single global credential when identities must be isolated.

## Backup and restore

Run a daily SQLite online backup to a location outside the repository, encrypt it, and retain multiple generations. Test restore periodically on a separate copy:

```bash
# Example operational commands; adapt paths and encryption to the host.
install -d -m 700 /var/backups/synapse
synapse-os backup /var/backups/synapse/synapse-$(date -u +%F).db

# Restore only after stopping the service and validating the backup checksum.
synapse-os restore /var/backups/synapse/synapse-YYYY-MM-DD.db --force
```

Do not restore over a live database. Stop the service, preserve the current database, restore, run integrity checks, and restart. Backups must not be committed to Git.

## Operational logging

Record timestamp, principal user ID, tool/action, outcome, status code, and latency. Do not record bearer tokens, full memory content, or sensitive request bodies. Use generic external errors and retain detailed diagnostics only in protected server logs.

## Troubleshooting

- `401`: check that the Manus connector sends the expected Bearer/API key and that the token exists in the server-side mapping.
- Tools not listed: verify the public URL terminates at `/mcp`, supports the SDK's Streamable HTTP transport, and that the reverse proxy preserves POST responses and streaming.
- `403` or empty results: inspect team membership and scope policy; do not solve this by allowing caller-supplied identity fields.
- SQLite busy errors: confirm WAL mode, busy timeout, disk health, and that only one service process writes the database.
- Digest not loaded at session start: add the Manus instruction/skill workaround; MCP tool descriptions alone cannot force a call.

## Production gate

Do not go live until the remote transport, principal-bound authorization, scope/team schema, rate limiting, and cross-user integration tests are implemented and green. A passing upstream test suite is insufficient because it covers local single-user behavior.

