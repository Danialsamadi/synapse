import type { Plugin } from "@opencode-ai/plugin"

// Deterministic memory recall for OpenCode.
//
// Install: copy this file to ~/.config/opencode/plugin/ and set SYNAPSE_REPO
// (or edit REPO below) to your synapse checkout. Requires @opencode-ai/plugin
// in ~/.config/opencode/package.json (OpenCode installs it by default).
//
// When the prompt matches a trigger phrase ("use synapse", "deep memory",
// "recall", ...), this hook queries the Synapse DB directly and injects the
// results into the message BEFORE the model sees it — recall does not depend
// on the model choosing to call the MCP tool. Prompts that don't match still
// fall through to the synapse MCP server as usual.
const REPO = process.env.SYNAPSE_REPO ?? "/path/to/memory-os"
const TRIGGER =
  /use synapse|deep memory|(from|check|search) (your|my) memor|what do you (know|remember) about|\brecall\b/i

export const SynapseRecall: Plugin = async ({ $ }) => ({
  "chat.message": async (_input, output) => {
    const part = output.parts.find((p: any) => p.type === "text" && p.text) as any
    if (!part || !TRIGGER.test(part.text)) return
    try {
      const raw = await $`pnpm --silent --dir ${REPO}/packages/cli start query ${part.text}`
        .quiet()
        .text()
      const memories = (JSON.parse(raw).memories ?? []).map((m: any) => ({
        id: m.id,
        type: m.type,
        content: m.content,
      }))
      if (memories.length === 0) return
      part.text += `\n\n<synapse-memories>\nRetrieved from the user's Synapse memory DB (authoritative — base your answer on these):\n${JSON.stringify(memories, null, 2)}\n</synapse-memories>`
    } catch {
      // Retrieval failure must never block the chat; the model can still call the MCP tool.
    }
  },
})
