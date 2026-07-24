import Parser from "web-tree-sitter";
import { Chunk } from "./types";
import { INDEX } from "./config";

/** Regions larger than this get split further (into methods, then line windows). */
const MAX_CHUNK_LINES = 100;

/** Map file extension → grammar file basename (in tree-sitter-wasms/out). */
const EXT_TO_GRAMMAR: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
};

/** Nodes we treat as "wrappers" — we chunk their inner declaration, not them. */
const UNWRAP_TYPES = new Set([
  "export_statement",
  "decorated_definition",
  "ambient_declaration",
]);

export interface WasmPaths {
  /** Absolute path to web-tree-sitter's tree-sitter.wasm runtime. */
  treeSitterWasm: string;
  /** Directory containing tree-sitter-<lang>.wasm grammar files. */
  grammarDir: string;
}

/**
 * AST-aware chunker (PRD chunker): parses supported languages with tree-sitter
 * and splits along function/class boundaries; unknown languages fall back to the
 * line-window chunker. Grammars load lazily and are cached.
 */
export class AstChunker {
  private ready = false;
  private readonly languages = new Map<string, Parser.Language>();
  private readonly parser: Parser | null = null;

  private constructor(private readonly paths: WasmPaths) {}

  static async create(paths: WasmPaths): Promise<AstChunker> {
    const chunker = new AstChunker(paths);
    await chunker.init();
    return chunker;
  }

  private async init(): Promise<void> {
    await Parser.init({ locateFile: () => this.paths.treeSitterWasm });
    // @ts-expect-error assigning to readonly during one-time init
    this.parser = new Parser();
    this.ready = true;
  }

  private async loadLanguage(grammar: string): Promise<Parser.Language | undefined> {
    if (this.languages.has(grammar)) return this.languages.get(grammar);
    try {
      const wasm = `${this.paths.grammarDir}/tree-sitter-${grammar}.wasm`;
      const lang = await Parser.Language.load(wasm);
      this.languages.set(grammar, lang);
      return lang;
    } catch {
      return undefined; // grammar missing → fall back to line windows
    }
  }

  /** Chunk one file — AST-aligned when the language is supported, else windowed. */
  async chunk(filePath: string, content: string): Promise<Chunk[]> {
    const ext = extname(filePath);
    const grammar = EXT_TO_GRAMMAR[ext];
    if (!this.ready || !this.parser || !grammar) return windowChunks(filePath, content);

    const lang = await this.loadLanguage(grammar);
    if (!lang) return windowChunks(filePath, content);

    this.parser.setLanguage(lang);
    const tree = this.parser.parse(content);
    const lines = content.split(/\r?\n/);
    const chunks = chunkByDeclarations(filePath, lines, tree.rootNode);
    tree.delete();
    return chunks.length > 0 ? chunks : windowChunks(filePath, content);
  }
}

/** Unwrap export/decorator wrappers to the declaration they contain. */
function unwrap(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let n = node;
  while (UNWRAP_TYPES.has(n.type)) {
    const inner = n.namedChildren.find((c) => !UNWRAP_TYPES.has(c.type));
    if (!inner) break;
    n = inner;
  }
  return n;
}

/**
 * Partition the file at top-level declaration boundaries so each chunk aligns to
 * a function/class. Oversized regions are split by their child declarations, then
 * by line windows as a last resort. Rows are 0-based from tree-sitter.
 */
function chunkByDeclarations(
  filePath: string,
  lines: string[],
  root: Parser.SyntaxNode,
): Chunk[] {
  const top = root.namedChildren.map(unwrap);
  if (top.length === 0) return [];

  // Cut points = start row of each top-level declaration; region i spans
  // [cut[i], cut[i+1]). The leading region (before the first cut) is preamble.
  const cuts = top.map((n) => n.startPosition.row);
  const boundaries = [0, ...cuts.filter((r) => r > 0), lines.length];
  const uniqueSorted = [...new Set(boundaries)].sort((a, b) => a - b);

  const chunks: Chunk[] = [];
  for (let i = 0; i < uniqueSorted.length - 1; i++) {
    const start = uniqueSorted[i];
    const end = uniqueSorted[i + 1];
    if (end - start <= MAX_CHUNK_LINES) {
      pushChunk(chunks, filePath, lines, start, end);
      continue;
    }
    // Oversized region: try to split by the child declarations of its node.
    const node = top.find((n) => n.startPosition.row === start);
    const subCuts = node
      ? node.namedChildren.map((c) => c.startPosition.row).filter((r) => r > start && r < end)
      : [];
    if (subCuts.length > 0) {
      const subBounds = [...new Set([start, ...subCuts, end])].sort((a, b) => a - b);
      for (let j = 0; j < subBounds.length - 1; j++) {
        splitOrPush(chunks, filePath, lines, subBounds[j], subBounds[j + 1]);
      }
    } else {
      splitOrPush(chunks, filePath, lines, start, end);
    }
  }
  return mergeAdjacent(chunks);
}

/**
 * Coalesce consecutive small chunks (e.g. a block of imports, one-liner types)
 * up to the target chunk size, so we don't emit dozens of 1-line embeddings.
 * Chunks are contiguous line ranges, so merging just re-joins their lines.
 */
function mergeAdjacent(chunks: Chunk[]): Chunk[] {
  const target = INDEX.chunkLines;
  const merged: Chunk[] = [];
  let cur: Chunk | undefined;
  for (const c of chunks) {
    if (cur) {
      const combined = c.endLine - cur.startLine + 1;
      const curSize = cur.endLine - cur.startLine + 1;
      if (combined <= target && curSize < target) {
        cur = { ...cur, endLine: c.endLine, text: cur.text + "\n" + c.text };
        continue;
      }
      merged.push(cur);
    }
    cur = c;
  }
  if (cur) merged.push(cur);
  return merged;
}

/** Emit a chunk, line-windowing it if still larger than the cap. */
function splitOrPush(
  chunks: Chunk[],
  filePath: string,
  lines: string[],
  start: number,
  end: number,
): void {
  if (end - start <= MAX_CHUNK_LINES) {
    pushChunk(chunks, filePath, lines, start, end);
    return;
  }
  const { chunkLines, chunkOverlapLines } = INDEX;
  const step = Math.max(1, chunkLines - chunkOverlapLines);
  for (let s = start; s < end; s += step) {
    pushChunk(chunks, filePath, lines, s, Math.min(s + chunkLines, end));
    if (s + chunkLines >= end) break;
  }
}

/** Append a chunk for rows [start, end) (0-based) if it has real content. */
function pushChunk(
  chunks: Chunk[],
  filePath: string,
  lines: string[],
  start: number,
  end: number,
): void {
  const text = lines.slice(start, end).join("\n");
  if (text.trim().length === 0) return;
  chunks.push({ filePath, startLine: start + 1, endLine: end, text });
}

function extname(filePath: string): string {
  const i = filePath.lastIndexOf(".");
  return i === -1 ? "" : filePath.slice(i).toLowerCase();
}

/** Line-window fallback, duplicated here to avoid a circular import with chunker. */
function windowChunks(filePath: string, content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  const { chunkLines, chunkOverlapLines } = INDEX;
  const step = Math.max(1, chunkLines - chunkOverlapLines);
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + chunkLines, lines.length);
    pushChunk(chunks, filePath, lines, start, end);
    if (end >= lines.length) break;
  }
  return chunks;
}
