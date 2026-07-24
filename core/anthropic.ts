import { ChatClient } from "./types";
import { sseLines } from "./chat";
import { fetchWithRetry } from "./http";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

/** Chat adapter for Anthropic's Messages API (PRD F4). No embeddings from Anthropic. */
export class AnthropicChatClient implements ChatClient {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {
    if (!apiKey) throw new Error("AnthropicChatClient: missing API key");
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  async complete(prompt: string): Promise<string> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: prompt }],
        }),
      },
      "Anthropic chat",
    );
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
  }

  async *stream(prompt: string): AsyncGenerator<string, void, unknown> {
    const res = await fetchWithRetry(
      `${this.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.model,
          max_tokens: MAX_TOKENS,
          stream: true,
          messages: [{ role: "user", content: prompt }],
        }),
      },
      "Anthropic chat",
    );

    for await (const data of sseLines(res)) {
      try {
        const evt = JSON.parse(data) as {
          type: string;
          delta?: { type?: string; text?: string };
        };
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          if (evt.delta.text) yield evt.delta.text;
        }
      } catch {
        // non-JSON event line — skip
      }
    }
  }
}
