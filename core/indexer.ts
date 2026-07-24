import { promises as fs } from "node:fs";
import * as path from "node:path";
import { walk } from "./walker";
import { chunkFile } from "./chunker";
import { hashContent } from "./hasher";
import { containsSecret } from "./secrets";
import { Chunk, Embedder, IndexedChunk, VectorStore } from "./types";
import { GEMINI } from "./config";

/** Pluggable chunker: line-based by default, AST-based when supplied. */
export type ChunkFn = (filePath: string, content: string) => Chunk[] | Promise<Chunk[]>;

export interface IndexProgress {
  phase: "walk" | "embed" | "done";
  filesTotal: number;
  filesDone: number;
  chunksEmbedded: number;
  currentFile?: string;
}

export interface IndexOptions {
  root: string;
  store: VectorStore;
  embedder: Embedder;
  /** Called after each file so callers can render a progress bar. */
  onProgress?: (p: IndexProgress) => void;
  /** If set, only (re)index files whose hash differs from the stored hash. */
  incremental?: boolean;
  /** Override the chunker (e.g. AST-based). Defaults to the line chunker. */
  chunk?: ChunkFn;
}

export interface IndexResult {
  filesIndexed: number;
  filesSkippedUnchanged: number;
  chunksEmbedded: number;
  chunksSkippedSecret: number;
  filesSkippedLarge: string[];
}

export interface IndexEstimate {
  files: number;
  chunks: number;
  /** Rough token count (~4 chars/token) for a pre-index cost estimate. */
  approxTokens: number;
  filesSkippedLarge: string[];
}

/**
 * Dry run: walk + chunk + secret-filter to count what *would* be embedded,
 * without making any API calls. Powers the pre-index cost estimate (PRD F1).
 */
export async function estimateIndex(root: string): Promise<IndexEstimate> {
  const { files, skippedLarge } = await walk(root);
  let chunks = 0;
  let chars = 0;
  for (const rel of files) {
    const content = await fs.readFile(path.join(root, rel), "utf8");
    for (const c of chunkFile(rel, content)) {
      if (containsSecret(c.text)) continue;
      chunks++;
      chars += c.text.length;
    }
  }
  return {
    files: files.length,
    chunks,
    approxTokens: Math.round(chars / 4),
    filesSkippedLarge: skippedLarge,
  };
}

/**
 * Full pipeline: walk → chunk → (secret-filter) → embed → store.
 * Reused by the CLI harness and the VS Code extension.
 */
export async function indexRepo(opts: IndexOptions): Promise<IndexResult> {
  const { root, store, embedder, onProgress, incremental } = opts;
  const chunkFn: ChunkFn = opts.chunk ?? chunkFile;

  const { files, skippedLarge } = await walk(root);
  onProgress?.({ phase: "walk", filesTotal: files.length, filesDone: 0, chunksEmbedded: 0 });

  // Record which embedding model built this index (PRD F4: locked per repo).
  const existingMeta = await store.meta();
  if (!existingMeta) {
    await store.setMeta({
      embeddingModel: embedder.model,
      dimension: GEMINI.embeddingDimension,
      createdAt: new Date().toISOString(),
    });
  } else if (existingMeta.embeddingModel !== embedder.model) {
    throw new Error(
      `Index was built with "${existingMeta.embeddingModel}" but embedder is "${embedder.model}". ` +
        `Changing embedding models requires a full re-index.`,
    );
  }

  const priorHashes = incremental ? await store.fileHashes() : new Map<string, string>();

  let filesIndexed = 0;
  let filesSkippedUnchanged = 0;
  let chunksEmbedded = 0;
  let chunksSkippedSecret = 0;

  for (const rel of files) {
    const content = await fs.readFile(path.join(root, rel), "utf8");
    const fileHash = hashContent(content);

    if (incremental && priorHashes.get(rel) === fileHash) {
      filesSkippedUnchanged++;
      continue;
    }

    const chunks = await chunkFn(rel, content);
    const safeChunks = chunks.filter((c) => {
      if (containsSecret(c.text)) {
        chunksSkippedSecret++;
        return false;
      }
      return true;
    });

    if (safeChunks.length === 0) {
      // File is now empty of indexable content — clear any stale rows.
      await store.deleteFile(rel);
      filesIndexed++;
      onProgress?.({
        phase: "embed",
        filesTotal: files.length,
        filesDone: filesIndexed + filesSkippedUnchanged,
        chunksEmbedded,
        currentFile: rel,
      });
      continue;
    }

    const vectors = await embedder.embedDocuments(safeChunks.map((c) => c.text));
    const indexed: IndexedChunk[] = safeChunks.map((c, i) => ({
      ...c,
      vector: vectors[i],
      fileHash,
    }));

    await store.upsertFile(rel, fileHash, indexed);
    filesIndexed++;
    chunksEmbedded += indexed.length;

    onProgress?.({
      phase: "embed",
      filesTotal: files.length,
      filesDone: filesIndexed + filesSkippedUnchanged,
      chunksEmbedded,
      currentFile: rel,
    });
  }

  onProgress?.({
    phase: "done",
    filesTotal: files.length,
    filesDone: filesIndexed + filesSkippedUnchanged,
    chunksEmbedded,
  });

  return {
    filesIndexed,
    filesSkippedUnchanged,
    chunksEmbedded,
    chunksSkippedSecret,
    filesSkippedLarge: skippedLarge,
  };
}
