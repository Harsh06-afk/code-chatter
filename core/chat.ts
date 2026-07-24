import { GEMINI } from "./config";
import { ChatClient } from "./types";
import { fetchWithRetry } from "./http";

interface GeminiCandidate {
  content?: { parts?: { text?: string }[] };
}

export class GeminiChatClient implements ChatClient {
  constructor(
    private readonly apiKey: string,
    readonly model: string = GEMINI.chatModel,
  ) {
    if (!apiKey) throw new Error("GeminiChatClient: missing API key");
  }

  async complete(prompt: string): Promise<string> {
    const url = `${GEMINI.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
      "Gemini chat",
    );

    const json = (await res.json()) as { candidates?: GeminiCandidate[] };
    return extractText(json.candidates).trim();
  }

  async *stream(prompt: string): AsyncGenerator<string, void, unknown> {
    const url = `${GEMINI.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
      "Gemini chat",
    );

    for await (const data of sseLines(res)) {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as { candidates?: GeminiCandidate[] };
        const text = extractText(json.candidates);
        if (text) yield text;
      } catch {
        // partial/keepalive line — skip
      }
    }
  }
}

function extractText(candidates?: GeminiCandidate[]): string {
  return candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

/** Yield the `data:` payload of each Server-Sent-Event line from a fetch stream. */
export async function* sseLines(res: Response): AsyncGenerator<string, void, unknown> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

export async function httpError(label: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`${label} failed (${res.status}): ${body.slice(0, 500)}`);
}
