import { promises as fs } from "node:fs";
import * as path from "node:path";
import { IndexedChunk, IndexMeta, Match, VectorStore } from "./types";

interface PersistShape {
  version: 1;
  meta?: IndexMeta;
  chunks: IndexedChunk[];
}

/**
 * Pure-TypeScript vector store: chunks + vectors held in memory, persisted as
 * one JSON file, nearest-neighbour by brute-force dot product.
 *
 * Vectors are stored L2-normalised (see embedder), so dot product == cosine.
 * At the PRD's target scale (~2k files, top-k=8) a linear scan is well under
 * 50 ms. store.ts is the sole implementer of VectorStore, so LanceDB can drop
 * in behind the same interface later without touching callers.
 */
export class JsonVectorStore implements VectorStore {
  private chunks: IndexedChunk[] = [];
  private metadata: IndexMeta | undefined;

  private constructor(private readonly filePath: string) {}

  /** Open (or create) the store at `filePath`. */
  static async open(filePath: string): Promise<JsonVectorStore> {
    const store = new JsonVectorStore(filePath);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const data = JSON.parse(raw) as PersistShape;
      store.chunks = data.chunks ?? [];
      store.metadata = data.meta;
    } catch {
      // no index yet — start empty
    }
    return store;
  }

  async upsertFile(filePath: string, _fileHash: string, chunks: IndexedChunk[]): Promise<void> {
    this.chunks = this.chunks.filter((c) => c.filePath !== filePath);
    this.chunks.push(...chunks);
    await this.persist();
  }

  async deleteFile(filePath: string): Promise<void> {
    const before = this.chunks.length;
    this.chunks = this.chunks.filter((c) => c.filePath !== filePath);
    if (this.chunks.length !== before) await this.persist();
  }

  async search(
    queryVector: number[],
    k: number,
    filter?: (filePath: string) => boolean,
  ): Promise<Match[]> {
    const pool = filter ? this.chunks.filter((c) => filter(c.filePath)) : this.chunks;
    const scored: Match[] = pool.map((chunk) => ({
      chunk,
      score: dot(queryVector, chunk.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  async fileHashes(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const c of this.chunks) map.set(c.filePath, c.fileHash);
    return map;
  }

  async meta(): Promise<IndexMeta | undefined> {
    return this.metadata;
  }

  async setMeta(meta: IndexMeta): Promise<void> {
    this.metadata = meta;
    await this.persist();
  }

  /** Total chunk count — handy for the CLI to report. */
  get size(): number {
    return this.chunks.length;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const data: PersistShape = { version: 1, meta: this.metadata, chunks: this.chunks };
    // Write to a temp file then rename, so a crash mid-write can't corrupt the index.
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

/** Dot product of two equal-length vectors (== cosine for unit vectors). */
function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}
