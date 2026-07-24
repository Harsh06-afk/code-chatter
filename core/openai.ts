import { ChatClient, Embedder } from "./types";
import { sseLines } from "./chat";
import { fetchWithRetry } from "./http";

/** L2-normalise so cosine reduces to a dot product in the store. */
function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

/**
 * Chat client for any OpenAI-compatible /chat/completions endpoint:
 * OpenAI, DeepSeek, Groq, and local Ollama all speak this shape (PRD F4).
 */
export class OpenAICompatibleChatClient implements ChatClient {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    // Ollama accepts any/no key; other providers require Bearer auth.
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  async complete(prompt: string): Promise<string> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
        }),
      },
      "OpenAI-compatible chat",
    );
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (json.choices?.[0]?.message?.content ?? "").trim();
  }

  async *stream(prompt: string): AsyncGenerator<string, void, unknown> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          stream: true,
        }),
      },
      "OpenAI-compatible chat",
    );

    for await (const data of sseLines(res)) {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const text = json.choices?.[0]?.delta?.content;
        if (text) yield text;
      } catch {
        // partial line — skip
      }
    }
  }
}

/** Embedder for OpenAI-compatible /embeddings endpoints (OpenAI, Ollama). */
export class OpenAICompatibleEmbedder implements Embedder {
  onRateLimit?: (waitMs: number) => void;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly batchSize = 100,
  ) {}

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.embed(texts.slice(i, i + this.batchSize))));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec;
  }

  private async embed(input: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const res = await fetchWithRetry(
      `${this.baseUrl}/embeddings`,
      { method: "POST", headers, body: JSON.stringify({ model: this.model, input }) },
      "OpenAI-compatible embed",
      (waitMs) => this.onRateLimit?.(waitMs),
    );
    const json = (await res.json()) as { data?: { embedding: number[] }[] };
    if (!json.data || json.data.length !== input.length) {
      throw new Error(`Embed: expected ${input.length} vectors, got ${json.data?.length ?? 0}`);
    }
    return json.data.map((d) => normalize(d.embedding));
  }
}
