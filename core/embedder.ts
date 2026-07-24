import { Embedder } from "./types";
import { GEMINI } from "./config";
import { fetchWithRetry } from "./http";

type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

interface GeminiEmbedRequest {
  model: string;
  content: { parts: { text: string }[] };
  taskType: TaskType;
  outputDimensionality: number;
}

/** L2-normalise so cosine similarity reduces to a dot product downstream.
 * Required for gemini-embedding-001 when outputDimensionality != 3072. */
function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export class GeminiEmbedder implements Embedder {
  readonly model = GEMINI.embeddingModel;

  /** Optional hook to surface rate-limit waits (e.g. to a progress bar). */
  onRateLimit?: (waitMs: number) => void;

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error("GeminiEmbedder: missing API key");
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += GEMINI.embedBatchSize) {
      const batch = texts.slice(i, i + GEMINI.embedBatchSize);
      const vectors = await this.embedBatch(batch, "RETRIEVAL_DOCUMENT");
      out.push(...vectors);
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text], "RETRIEVAL_QUERY");
    return vec;
  }

  private async embedBatch(texts: string[], taskType: TaskType): Promise<number[][]> {
    const url = `${GEMINI.baseUrl}/models/${GEMINI.embeddingModel}:batchEmbedContents?key=${this.apiKey}`;
    const requests: GeminiEmbedRequest[] = texts.map((text) => ({
      model: `models/${GEMINI.embeddingModel}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: GEMINI.embeddingDimension,
    }));

    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      },
      "Gemini embed",
      (waitMs) => this.onRateLimit?.(waitMs),
    );

    const json = (await res.json()) as { embeddings?: { values: number[] }[] };
    if (!json.embeddings || json.embeddings.length !== texts.length) {
      throw new Error(
        `Gemini embed: expected ${texts.length} embeddings, got ${json.embeddings?.length ?? 0}`,
      );
    }
    return json.embeddings.map((e) => normalize(e.values));
  }
}
