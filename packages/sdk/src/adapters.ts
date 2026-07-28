import { MEMORY_TOOLS, type ToolDefinition } from "./tools.js";

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Anthropic Messages API `tools` entry. */
export function toAnthropicTools(tools: ToolDefinition[] = MEMORY_TOOLS): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/** OpenAI Chat Completions `tools` entry — also OpenRouter/Groq/Ollama/Mistral. */
export function toOpenAiTools(tools: ToolDefinition[] = MEMORY_TOOLS): OpenAiTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/**
 * Anthropic `tool_choice` that forces a memory tool call. Pass on the FIRST
 * request of a turn only, then drop it on the follow-up call — forcing every
 * call loops forever, and Anthropic forbids forced tool use with extended
 * thinking.
 */
export function anthropicForceTool(name = "memory_retrieve") {
  return { type: "tool", name } as const;
}

/** OpenAI `tool_choice` equivalent of {@link anthropicForceTool} — same first-call-only rule. */
export function openAiForceTool(name = "memory_retrieve") {
  return { type: "function", function: { name } } as const;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * Normalize a provider tool call into {id, name, args} for executeMemoryTool.
 * Accepts an Anthropic tool_use content block or an OpenAI chat tool_call.
 */
export function parseToolCall(raw: unknown): NormalizedToolCall {
  if (typeof raw !== "object" || raw === null) throw new Error("tool call must be an object");
  const r = raw as Record<string, unknown>;

  // Anthropic: {type: "tool_use", id, name, input}
  if (r["type"] === "tool_use" && typeof r["name"] === "string") {
    return { id: String(r["id"] ?? ""), name: r["name"], args: r["input"] };
  }

  // OpenAI: {id, type: "function", function: {name, arguments: string}}
  const fn = r["function"];
  if (typeof fn === "object" && fn !== null) {
    const f = fn as Record<string, unknown>;
    if (typeof f["name"] === "string" && typeof f["arguments"] === "string") {
      return { id: String(r["id"] ?? ""), name: f["name"], args: JSON.parse(f["arguments"]) as unknown };
    }
  }

  throw new Error("Unrecognized tool call shape (expected Anthropic tool_use or OpenAI tool_call)");
}
