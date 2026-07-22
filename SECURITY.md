# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/Danialsamadi/synapse/security/advisories/new).
Do not open public issues for security reports. You can expect an initial response
within 7 days.

## Threat model in brief

Synapse is local-first: memory data lives in a SQLite file on your machine
(`~/.synapse/synapse.db` by default) and is never sent anywhere unless you configure
a remote embedding/LLM provider. The HTTP API binds to localhost and requires a
bearer token (`SYNAPSE_TOKEN`) for mutating routes. See the privacy disclosure in the
README for details on network binding and where memory data goes.

## Supported versions

Only the latest released minor version receives security fixes.
