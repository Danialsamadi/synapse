import { MemoryTypeSchema, resolveDbPath } from "@synapse/core";
import { MemoryRepository, RetrievalService, createEmbedder, reembedAll, writeMemory } from "@synapse/store";
import { splitIntoMemories } from "./import.js";

const dbPath = resolveDbPath;

function usage(code = 1): never {
  console.log(`synapse — Personal AI Memory OS CLI

Usage:
  synapse remember <type> <content...>
  synapse import <file.md> [--type <type>] [--tags <tag1,tag2>] [--date <iso>]
  synapse list [--type <type>]
  synapse get <id>
  synapse query <text...> [--type <type>] [--tags <tag1,tag2>]
  synapse export
  synapse reembed              (after switching embedding provider/model)
  synapse backup [dest]
  synapse restore <src> --force
  synapse delete <id>
  synapse mcp                  (default: start the stdio MCP server)

Types: episodic | semantic | procedural | working
Env: SYNAPSE_DB=path/to.db (default: ~/.synapse/synapse.db)
     SYNAPSE_EMBED_PROVIDER=hash|openai|local (default: openai if a key/base
     URL is configured, else hash — see README for the provider matrix)
`);
  process.exit(code);
}

/** Shared CLI dispatch — same store, env, and guards as the MCP server. */
export async function runCli(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd) usage();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") usage(0);

  if (cmd === "restore") {
    // Handled before opening the repository: restoring over a live handle corrupts WAL state.
    const src = rest.find((a) => a !== "--force");
    if (!src) usage();
    if (!rest.includes("--force")) {
      console.error(`This overwrites ${dbPath()}. Re-run with --force to confirm.`);
      process.exit(1);
    }
    const { copyFileSync, rmSync, existsSync } = await import("node:fs");
    const target = dbPath();
    // Stranding guard: a live holder (running MCP server/gateway) keeps its open
    // handle after the copy — its writes diverge from the restored file. Probe:
    // leaving WAL mode needs exclusive access, so it fails iff a holder exists.
    if (existsSync(target)) {
      const { default: Database } = await import("better-sqlite3");
      let live = false;
      const probe = new Database(target, { timeout: 200 });
      try {
        live = probe.pragma("journal_mode = delete", { simple: true }) !== "delete";
      } catch {
        live = true; // SQLITE_BUSY → someone holds it
      } finally {
        probe.close();
      }
      if (live) {
        console.error(
          `${target} is open in another process (a running synapse MCP server or gateway). ` +
            "Restoring under a live holder strands its writes — stop that process, then re-run restore.",
        );
        process.exitCode = 1;
        return;
      }
    }
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
        // Route through writeMemory, not repo.create(): gets the secret gate,
        // semantic dedup, AND an embedding (direct create() stored none, leaving
        // CLI memories invisible to vector retrieval).
        const outcome = await writeMemory(repo, createEmbedder(), {
          userId: "local",
          type,
          content,
          source: "cli",
        });
        if ("rejected" in outcome) {
          console.error(
            `Rejected: content appears to contain a credential (${outcome.kind}). ` +
              `Synapse does not store secrets — use a password manager. Override: SYNAPSE_ALLOW_SECRETS=1`,
          );
          process.exitCode = 1;
          break;
        }
        console.log(JSON.stringify(
          outcome.deduped ? { deduped: true, memory: outcome.memory } : outcome.memory,
          null,
          2,
        ));
        break;
      }
      case "import": {
        // Seed memory from an existing doc (CLAUDE.md, notes): one memory per
        // bullet/paragraph, through writeMemory so dedup + the secret gate apply.
        let type: ReturnType<typeof MemoryTypeSchema.parse> = "semantic";
        let tags: string[] | undefined;
        let file: string | undefined;
        let date: string | undefined;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--type" && rest[i + 1]) type = MemoryTypeSchema.parse(rest[++i]);
          else if (rest[i] === "--tags" && rest[i + 1]) tags = rest[++i]!.split(",");
          else if (rest[i] === "--date" && rest[i + 1]) date = rest[++i];
          else file ??= rest[i];
        }
        if (!file) usage();
        if (date && Number.isNaN(Date.parse(date))) {
          console.error(`--date "${date}" is not a parseable date`);
          process.exit(1);
        }
        const { readFileSync } = await import("node:fs");
        const chunks = splitIntoMemories(readFileSync(file, "utf-8"));
        const embedder = createEmbedder();
        // Event time: when the doc's facts were true (--date), else now.
        const observedAt = date ?? new Date().toISOString();
        let imported = 0, deduped = 0, rejected = 0;
        for (const content of chunks) {
          const outcome = await writeMemory(repo, embedder, {
            userId: "local",
            type,
            content,
            source: "cli",
            ...(tags ? { tags } : {}),
            sourceRefs: [{ kind: "file", id: file, observedAt }],
          });
          if ("rejected" in outcome) rejected++;
          else if (outcome.deduped) deduped++;
          else imported++;
        }
        console.log(JSON.stringify({ file, chunks: chunks.length, imported, deduped, rejected }, null, 2));
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
        // Walk args once: a --flag consumes the next token as its value, the
        // rest is query text. (Filtering flags/positionals separately loses
        // flag values into the query — the old bug.)
        let type: ReturnType<typeof MemoryTypeSchema.parse> | undefined;
        let tags: string[] | undefined;
        const positional: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--type" && rest[i + 1]) type = MemoryTypeSchema.parse(rest[++i]);
          else if (rest[i] === "--tags" && rest[i + 1]) tags = rest[++i]!.split(",");
          else positional.push(rest[i]!);
        }
        const q = positional.join(" ").trim();
        if (!q) usage();

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
