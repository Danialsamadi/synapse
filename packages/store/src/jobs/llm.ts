import { execFile } from "node:child_process";

export interface LlmClient {
  complete(system: string, user: string): Promise<string>;
}

export interface OpenAiLlmConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
}

export class OpenAiCompatLlm implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;

  constructor(config?: OpenAiLlmConfig) {
    this.baseUrl = config?.baseUrl ?? process.env.SYNAPSE_LLM_BASE_URL ?? "https://api.openai.com/v1";
    this.apiKey = config?.apiKey ?? process.env.SYNAPSE_LLM_API_KEY ?? "";
    this.model = config?.model ?? process.env.SYNAPSE_LLM_MODEL ?? "gpt-4o-mini";
    this.temperature = config?.temperature ?? Number(process.env.SYNAPSE_LLM_TEMPERATURE ?? "0");
  }

  async complete(system: string, user: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        temperature: this.temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM request failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  }
}

export class FakeLlm implements LlmClient {
  private i = 0;
  constructor(private readonly responses: string[]) {}
  async complete(): Promise<string> {
    return this.responses[this.i++] ?? this.responses[this.responses.length - 1] ?? "";
  }
}

export interface ClaudeCliConfig {
  /** Model alias/id passed to --model (default "haiku"). */
  model?: string;
  /** Command prefix (default ["claude"]); override for tests. */
  cmd?: string[];
  timeoutMs?: number;
}

/**
 * LlmClient backed by the local `claude -p` CLI — uses Claude Code's existing
 * auth, no API key. User prompt goes via stdin (argv has length limits),
 * system prompt via --append-system-prompt.
 */
export class ClaudeCliLlm implements LlmClient {
  constructor(private readonly config: ClaudeCliConfig = {}) {}

  complete(system: string, user: string): Promise<string> {
    const [cmd, ...prefix] = this.config.cmd ?? ["claude"];
    const args = [
      ...prefix,
      "-p",
      "--model",
      this.config.model ?? "haiku",
      "--append-system-prompt",
      system,
    ];
    return new Promise((resolve, reject) => {
      const child = execFile(
        cmd!,
        args,
        { timeout: this.config.timeoutMs ?? 300_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
      );
      child.stdin?.end(user);
    });
  }
}
