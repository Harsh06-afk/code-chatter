import { Chunk } from "./types";
import { INDEX } from "./config";

/**
 * Line-based sliding-window chunker (PRD's fallback strategy).
 * Tree-sitter AST chunking replaces this for supported languages in a later step;
 * the function/class chunker will produce Chunks with the same shape.
 */
export function chunkFile(filePath: string, content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  const { chunkLines, chunkOverlapLines } = INDEX;
  const step = Math.max(1, chunkLines - chunkOverlapLines);
  const chunks: Chunk[] = [];

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + chunkLines, lines.length);
    const text = lines.slice(start, end).join("\n");
    if (text.trim().length === 0) {
      if (end >= lines.length) break;
      continue;
    }
    chunks.push({
      filePath,
      startLine: start + 1, // 1-based, inclusive
      endLine: end,
      text,
    });
    if (end >= lines.length) break;
  }

  return chunks;
}
