#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MemoryTypeSchema } from "@mneme/core";
import { MemoryRepository } from "@mneme/store";

function dbPath(): string {
  const p = process.env.MNEME_DB ?? resolve(process.cwd(), ".mneme", "mneme.db");
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

function usage(): never {
  console.log(`mneme — Personal AI Memory OS CLI

Usage:
  mneme remember <type> <content...>
  mneme list [--type <type>]
  mneme get <id>
  mneme delete <id>

Types: episodic | semantic | procedural | working
Env: MNEME_DB=path/to.db (default: ./.mneme/mneme.db)
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  const repo = new MemoryRepository({ path: dbPath() });

  try {
    switch (cmd) {
      case "remember": {
        const typeRaw = rest[0];
        const content = rest.slice(1).join(" ").trim();
        if (!typeRaw || !content) usage();
        const type = MemoryTypeSchema.parse(typeRaw);
        const existing = repo.findActiveByContentHash("local", type, content);
        if (existing) {
          console.log(JSON.stringify({ deduped: true, memory: existing }, null, 2));
          break;
        }
        const memory = repo.create({ userId: "local", type, content });
        console.log(JSON.stringify(memory, null, 2));
        break;
      }
      case "list": {
        let type: ReturnType<typeof MemoryTypeSchema.parse> | undefined;
        const typeIdx = rest.indexOf("--type");
        if (typeIdx >= 0 && rest[typeIdx + 1]) {
          type = MemoryTypeSchema.parse(rest[typeIdx + 1]);
        }
        const rows = repo.list("local", {
          status: "active",
          ...(type ? { type } : {}),
        });
        console.log(JSON.stringify(rows, null, 2));
        break;
      }
      case "get": {
        const id = rest[0];
        if (!id) usage();
        console.log(JSON.stringify(repo.get(id), null, 2));
        break;
      }
      case "delete": {
        const id = rest[0];
        if (!id) usage();
        console.log(JSON.stringify({ ok: repo.softDelete(id) }));
        break;
      }
      default:
        usage();
    }
  } finally {
    repo.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
