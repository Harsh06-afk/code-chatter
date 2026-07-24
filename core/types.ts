// Shared types for the CodeChatter core pipeline.
// Kept IDE-agnostic so the VS Code extension and the CLI harness share one contract.

/** A slice of a source file, ready to be embedded. */
export interface Chunk {
  filePath: string; // workspace-relative POSIX path
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
  text: string;
}

/** A chunk plus its embedding vector and the hash of the file it came from. */
export interface IndexedChunk extends Chunk {
  vector: number[];
  fileHash: string; // SHA-256 of the whole source file, for stale detection
}

/** A retrieval hit: a stored chunk with its similarity score to the query. */
export interface Match {
  chunk: IndexedChunk;
  score: number; // cosine similarity, higher = closer
}

/** Chat model client. One implementation per provider family. */
export interface ChatClient {
  /** Model id, e.g. "gemini-2.5-flash". */
  readonly model: string;
  /** Single-shot completion for a fully-assembled prompt. */
  complete(prompt: string): Promise<string>;
  /** Streaming completion — yields answer fragments as they arrive. */
  stream(prompt: string): AsyncGenerator<string, void, unknown>;
}

/** Turns text into vectors. One implementation per provider. */
export interface Embedder {
  /** Model id, e.g. "gemini-embedding-001". Stored in index metadata. */
  readonly model: string;
  /** Optional hook fired when a request is rate-limited and retrying after waitMs. */
  onRateLimit?: (waitMs: number) => void;
  /** Embed a batch of documents (for indexing). */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Embed a single query (for retrieval). */
  embedQuery(text: string): Promise<number[]>;
}

/** Persists vectors and answers nearest-neighbour queries. */
export interface VectorStore {
  /** Replace all chunks for the given files, then persist. */
  upsertFile(filePath: string, fileHash: string, chunks: IndexedChunk[]): Promise<void>;
  /** Remove every chunk belonging to a file. */
  deleteFile(filePath: string): Promise<void>;
  /** Top-k nearest chunks to a query vector by cosine similarity.
   * An optional filter restricts the search to matching file paths (for #file/#folder scoping). */
  search(queryVector: number[], k: number, filter?: (filePath: string) => boolean): Promise<Match[]>;
  /** Map of filePath -> stored fileHash, for stale detection. */
  fileHashes(): Promise<Map<string, string>>;
  /** Metadata recorded at index creation (embedding model, dimension). */
  meta(): Promise<IndexMeta | undefined>;
  setMeta(meta: IndexMeta): Promise<void>;
}

export interface IndexMeta {
  embeddingModel: string;
  dimension: number;
  createdAt: string;
}
