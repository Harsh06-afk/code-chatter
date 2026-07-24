import * as vscode from "vscode";
import * as path from "node:path";
import { estimateIndex, indexRepo, ChunkFn } from "../core/indexer";
import { createEmbedder } from "../core/providers";
import { AstChunker } from "../core/astChunker";
import { openStore, workspaceRoot } from "./storage";
import { buildClientOptions, embeddingProvider } from "./settings";
import { StatusBar } from "./statusBar";

/** Build an AST-based chunk function from the bundled wasm, or fall back to
 * the line chunker if tree-sitter can't initialise. */
async function buildChunker(context: vscode.ExtensionContext): Promise<ChunkFn | undefined> {
  try {
    const wasmDir = path.join(context.extensionPath, "dist", "wasm");
    const chunker = await AstChunker.create({
      treeSitterWasm: path.join(wasmDir, "tree-sitter.wasm"),
      grammarDir: wasmDir,
    });
    return (filePath, content) => chunker.chunk(filePath, content);
  } catch (err) {
    console.warn("CodeChatter: AST chunker unavailable, using line chunker.", err);
    return undefined;
  }
}

/** Run a full or incremental index with a VS Code progress bar (PRD F1/F3). */
export async function runIndex(
  context: vscode.ExtensionContext,
  status: StatusBar,
  incremental: boolean,
): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage("CodeChatter: open a folder to index.");
    return;
  }

  const provider = embeddingProvider();
  const opts = await buildClientOptions(context, provider, "embed");
  if (!opts) return;

  let embedder;
  try {
    embedder = createEmbedder(opts);
  } catch (err) {
    vscode.window.showErrorMessage(`CodeChatter: ${errMsg(err)}`);
    return;
  }

  // Pre-index cost estimate + confirmation (full index only).
  if (!incremental) {
    const est = await estimateIndex(root);
    if (est.chunks === 0) {
      vscode.window.showInformationMessage("CodeChatter: nothing to index in this workspace.");
      return;
    }
    const proceed = await vscode.window.showInformationMessage(
      `Index ${est.files} files (~${est.chunks} chunks, ~${formatTokens(est.approxTokens)} tokens) ` +
        `with ${provider}? Embeddings are typically free-tier or a fraction of a cent.`,
      { modal: true },
      "Index",
    );
    if (proceed !== "Index") return;
  }

  const store = await openStore(context);
  if (!store) return;

  const chunk = await buildChunker(context);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: incremental ? "CodeChatter: re-indexing changed files" : "CodeChatter: indexing repo",
      cancellable: false,
    },
    async (progress) => {
      let last = 0;
      embedder.onRateLimit = (waitMs) =>
        progress.report({ message: `rate limited — waiting ${Math.ceil(waitMs / 1000)}s…` });
      const result = await indexRepo({
        root,
        store,
        embedder,
        incremental,
        chunk,
        onProgress: (p) => {
          if (p.filesTotal > 0) {
            const pct = Math.round((p.filesDone / p.filesTotal) * 100);
            progress.report({ increment: pct - last, message: p.currentFile ?? "" });
            last = pct;
          }
        },
      });
      status.clearStale();
      await status.refresh();
      vscode.window.showInformationMessage(
        `CodeChatter: indexed ${result.filesIndexed} files (${result.chunksEmbedded} chunks)` +
          (result.chunksSkippedSecret ? `, skipped ${result.chunksSkippedSecret} secret chunk(s)` : ""),
      );
    },
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
