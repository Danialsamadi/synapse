export interface LlmClient {
  complete(system: string, user: string): Promise<string>;
}

export class OpenAiCompatLlm implements LlmClient {
  private readonly baseUrl = process.env.MNEME_LLM_BASE_URL ?? "https://api.openai.com/v1";
  private readonly apiKey = process.env.MNEME_LLM_API_KEY ?? "";
  private readonly model = process.env.MNEME_LLM_MODEL ?? "gpt-4o-mini";

  async complete(system: string, user: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }
}

export class FakeLlm implements LlmClient {
  private i = 0;
  constructor(private readonly responses: string[]) {}
  async complete(): Promise<string> {
    return this.responses[this.i++] ?? this.responses[this.responses.length - 1] ?? "";
  }
}
