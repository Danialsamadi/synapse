#!/usr/bin/env node
import { MemoryTypeSchema, resolveDbPath } from "@synapse/core";
import { MemoryRepository, RetrievalService, createEmbedder, reembedAll } from "@synapse/store";

const dbPath = resolveDbPath;

function usage(): never {
  console.log(`synapse — Personal AI Memory OS CLI

Usage:
  synapse remember <type> <content...>
  synapse list [--type <type>]
  synapse get <id>
  synapse query <text...> [--type <type>] [--tags <tag1,tag2>]
  synapse export
  synapse reembed              (after switching embedding provider/model)
  synapse backup [dest]
  synapse restore <src> --force
  synapse delete <id>

Types: episodic | semantic | procedural | working
Env: SYNAPSE_DB=path/to.db (default: ~/.synapse/synapse.db)
`);
  process.exit(1);
}

async function main(): Promise<void> {
  process.env.SYNAPSE_EMBED_PROVIDER ??= "local";
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  if (cmd === "restore") {
    // Handled before opening the repository: restoring over a live handle corrupts WAL state.
    const src = rest.find((a) => a !== "--force");
    if (!src) usage();
    if (!rest.includes("--force")) {
      console.error(`This overwrites ${dbPath()}. Re-run with --force to confirm.`);
      process.exit(1);
    }
    const { copyFileSync, rmSync } = await import("node:fs");
    const target = dbPath();
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
    copyFileSync(src, target);
    console.log(`Restored ${target} from ${src}`);
    return;
  }

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
        const memory = repo.create({ userId: "local", type, content, source: "cli" });
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
      case "query": {
        const flags = rest.filter((a) => a.startsWith("--"));
        const positional = rest.filter((a) => !a.startsWith("--"));
        const q = positional.join(" ").trim();
        if (!q) usage();

        let type: ReturnType<typeof MemoryTypeSchema.parse> | undefined;
        const typeIdx = flags.indexOf("--type");
        const typeVal = typeIdx >= 0 ? flags[typeIdx + 1] : undefined;
        if (typeVal) {
          type = MemoryTypeSchema.parse(typeVal);
        }

        let tags: string[] | undefined;
        const tagsIdx = flags.indexOf("--tags");
        const tagsVal = tagsIdx >= 0 ? flags[tagsIdx + 1] : undefined;
        if (tagsVal) {
          tags = tagsVal.split(",");
        }

        const svc = new RetrievalService(repo, createEmbedder());
        const res = await svc.retrieve({
          query: q,
          userId: "local",
          limit: 8,
          ...(type ? { types: [type] } : {}),
          ...(tags ? { tags } : {}),
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }
      case "export": {
        console.log(JSON.stringify(repo.exportAll("local"), null, 2));
        break;
      }
      case "reembed": {
        const embedder = createEmbedder();
        console.log(`Re-embedding with ${embedder.model}...`);
        const { reembedded } = await reembedAll(repo, embedder, (done, total) => {
          if (done % 128 === 0 || done === total) console.log(`  ${done}/${total}`);
        });
        console.log(`Done: ${reembedded} memories re-embedded.`);
        break;
      }
      case "backup": {
        const dest = rest[0] ?? `${dbPath()}.backup-${new Date().toISOString().slice(0, 10)}`;
        await repo.backup(dest);
        console.log(`Backed up to ${dest}`);
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
