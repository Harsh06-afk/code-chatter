// Central config: model ids, endpoints, and indexing constants.
// Verify model names against provider docs at build time (see PRD §3).

export const GEMINI = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  // Verified current as of 2026-07: gemini-embedding-001 is GA.
  embeddingModel: "gemini-embedding-001",
  // gemini-2.5-flash was pulled for new users (July 2026); 3.5-flash is the GA replacement.
  chatModel: "gemini-3.5-flash",
  // gemini-embedding-001 supports output_dimensionality; 768 keeps the index small
  // and is plenty for top-k=8 retrieval. Locked per index in IndexMeta.
  embeddingDimension: 768,
  // Gemini caps batchEmbedContents at 100 requests/call.
  embedBatchSize: 100,
} as const;

export const INDEX = {
  /** Files larger than this are skipped entirely (PRD F5). */
  maxFileBytes: 1024 * 1024, // 1 MB
  /** Sliding-window chunk size for the line-based fallback chunker. */
  chunkLines: 60,
  /** Overlap between adjacent line windows, to avoid splitting context. */
  chunkOverlapLines: 10,
  /** How many chunks to retrieve per question (PRD: top-k=8). */
  topK: 8,
  /**
   * Minimum cosine similarity for a chunk to count as relevant. Calibrated for
   * gemini-embedding-001 @ 768d: off-topic queries peak ~0.54, on-topic floor
   * ~0.60, so 0.55 cleanly separates them. Below this we say "not found" rather
   * than feed irrelevant context to the model.
   */
  minScore: 0.55,
} as const;

/** Directory name for the on-disk index, relative to the workspace root (CLI mode). */
export const INDEX_DIR = ".codechatter";
