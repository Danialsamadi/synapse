import {
  CreateMemoryInputSchema,
  RetrieveRequestSchema,
  type CreateMemoryInput,
  type Memory,
  type RetrieveRequest,
  type RetrievedMemory,
} from "@mneme/core";

export type { CreateMemoryInput, Memory, RetrieveRequest, RetrievedMemory };
export { CreateMemoryInputSchema, RetrieveRequestSchema };

export interface MnemeClientOptions {
  baseUrl: string;
  token?: string;
}

export class MnemeClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(options: MnemeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
  }

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    const body = CreateMemoryInputSchema.parse(input);
    return this.request<Memory>("POST", "/v1/memories", body);
  }

  async getMemory(id: string): Promise<Memory> {
    return this.request<Memory>("GET", `/v1/memories/${id}`);
  }

  async retrieve(
    input: RetrieveRequest,
  ): Promise<{ memories: RetrievedMemory[] }> {
    const body = RetrieveRequestSchema.parse(input);
    return this.request("POST", "/v1/memories/retrieve", body);
  }

  async deleteMemory(id: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/v1/memories/${id}`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mneme API ${method} ${path} → ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }
}
