#!/usr/bin/env node
// CLI harness for validating the CodeChatter pipeline end-to-end, independent of
// VS Code. Reads the API key from GEMINI_API_KEY.
//
//   npm run cc -- index <dir>          build/refresh the index for <dir>
//   npm run cc -- ask "<question>"     retrieve + answer against the last index
//   npm run cc -- search "<query>"     show top-k retrieved chunks (no LLM call)
//
// The index is stored under <dir>/.codechatter/index.json (default dir = cwd).

import * as path from "node:path";
import { JsonVectorStore } from "../core/store";
import { GeminiEmbedder } from "../core/embedder";
import { GeminiChatClient } from "../core/chat";
import { indexRepo, ChunkFn } from "../core/indexer";
import { retrieve, buildGitPrompt } from "../core/retriever";
import { isGitRepo, recentCommitsContext } from "../core/git";
import { AstChunker } from "../core/astChunker";
import { INDEX_DIR } from "../core/config";

/** AST chunker resolving wasm assets from node_modules (CLI/dev mode). */
async function cliChunker(): Promise<ChunkFn | undefined> {
  try {
    const wts = path.dirname(require.resolve("web-tree-sitter/package.json"));
    const grammarDir = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
    const chunker = await AstChunker.create({
      treeSitterWasm: path.join(wts, "tree-sitter.wasm"),
      grammarDir,
    });
    return (f, c) => chunker.chunk(f, c);
  } catch (err) {
    console.warn("AST chunker unavailable, using line chunker:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("Error: set GEMINI_API_KEY in your environment.");
    process.exit(1);
  }
  return key;
}

function indexPath(root: string): string {
  return path.join(root, INDEX_DIR, "index.json");
}

async function cmdIndex(root: string, incremental: boolean): Promise<void> {
  const apiKey = getApiKey();
  const store = await JsonVectorStore.open(indexPath(root));
  const embedder = new GeminiEmbedder(apiKey);

  embedder.onRateLimit = (waitMs) => {
    process.stdout.write(`\r  rate limited — waiting ${Math.ceil(waitMs / 1000)}s…`.padEnd(100));
  };

  const chunk = await cliChunker();
  const start = Date.now();
  const result = await indexRepo({
    root,
    store,
    embedder,
    incremental,
    chunk,
    onProgress: (p) => {
      if (p.phase === "embed" && p.currentFile) {
        process.stdout.write(
          `\r[${p.filesDone}/${p.filesTotal}] ${p.chunksEmbedded} chunks · ${p.currentFile}`.padEnd(
            100,
          ),
        );
      }
    },
  });

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  process.stdout.write("\r".padEnd(101) + "\r");
  console.log(`Indexed ${result.filesIndexed} files (${result.chunksEmbedded} chunks) in ${secs}s`);
  if (result.filesSkippedUnchanged) console.log(`  ${result.filesSkippedUnchanged} unchanged, skipped`);
  if (result.chunksSkippedSecret) console.log(`  ${result.chunksSkippedSecret} chunks skipped (secret pattern)`);
  if (result.filesSkippedLarge.length) console.log(`  ${result.filesSkippedLarge.length} files skipped (>1MB)`);
}

async function cmdSearch(root: string, query: string): Promise<void> {
  const apiKey = getApiKey();
  const store = await JsonVectorStore.open(indexPath(root));
  const embedder = new GeminiEmbedder(apiKey);
  // Debug view: show the raw top-k regardless of the relevance threshold.
  const { matches } = await retrieve(query, store, embedder, undefined, { minScore: 0 });
  for (const m of matches) {
    const { filePath, startLine, endLine } = m.chunk;
    console.log(`${m.score.toFixed(3)}  ${filePath}:${startLine}-${endLine}`);
  }
}

async function cmdAsk(root: string, question: string): Promise<void> {
  const apiKey = getApiKey();
  const store = await JsonVectorStore.open(indexPath(root));
  const embedder = new GeminiEmbedder(apiKey);
  const chat = new GeminiChatClient(apiKey);

  const { matches, prompt } = await retrieve(question, store, embedder);
  if (matches.length === 0) {
    console.log("No relevant code found in the index for that question.");
    return;
  }
  const answer = await chat.complete(prompt);

  console.log(answer);
  console.log("\nSources:");
  for (const m of matches) {
    console.log(`  ${m.chunk.filePath}:${m.chunk.startLine}-${m.chunk.endLine}`);
  }
}

async function cmdChanges(root: string, n: number, question: string): Promise<void> {
  const apiKey = getApiKey();
  if (!(await isGitRepo(root))) {
    console.error("Not a git repository — git-aware questions need git history.");
    process.exit(1);
  }
  const chat = new GeminiChatClient(apiKey);
  const context = await recentCommitsContext(root, n);
  const q = question || `Summarize what changed in the last ${n} commits.`;
  const answer = await chat.complete(buildGitPrompt(q, context));
  console.log(answer);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "index": {
      const root = path.resolve(rest[0] ?? ".");
      await cmdIndex(root, rest.includes("--incremental"));
      break;
    }
    case "ask": {
      const question = rest.filter((a) => !a.startsWith("--")).join(" ");
      if (!question) return usage();
      await cmdAsk(process.cwd(), question);
      break;
    }
    case "search": {
      const query = rest.filter((a) => !a.startsWith("--")).join(" ");
      if (!query) return usage();
      await cmdSearch(process.cwd(), query);
      break;
    }
    case "changes": {
      const nArg = rest.find((a) => /^\d+$/.test(a));
      const n = nArg ? parseInt(nArg, 10) : 5;
      const question = rest.filter((a) => !a.startsWith("--") && a !== nArg).join(" ");
      await cmdChanges(process.cwd(), n, question);
      break;
    }
    default:
      usage();
  }
}

function usage(): void {
  console.log(`CodeChatter CLI
  index <dir> [--incremental]   build or refresh the index
  ask "<question>"              answer a question about the indexed repo
  search "<query>"              show top-k retrieved chunks (no LLM call)
  changes [N] ["<question>"]    answer from the last N commits' diffs (default 5)

Set GEMINI_API_KEY in your environment.`);
}

main().catch((err) => {
  console.error("\n" + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
