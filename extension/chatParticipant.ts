import * as vscode from "vscode";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { createChatClient, createEmbedder } from "../core/providers";
import { retrieve, buildGitPrompt, buildContextPrompt, condenseQuestion } from "../core/retriever";
import { isGitRepo, recentCommitsContext } from "../core/git";
import { Match } from "../core/types";
import { openStore, workspaceRoot } from "./storage";
import { buildClientOptions, chatProvider, embeddingProvider, topK, minScore } from "./settings";

/** Total chars of directly-read referenced-file content included as fallback. */
const DIRECT_FILE_BUDGET = 12000;

/**
 * @codechatter chat participant (PRD F2). Two paths:
 *  - /changes [N]  → answer from the last N commits' diffs (git-aware, v2)
 *  - default       → RAG: retrieve top-k chunks, stream an answer, cite sources.
 */
export function createChatHandler(context: vscode.ExtensionContext): vscode.ChatRequestHandler {
  return async (request, chatContext, stream, token) => {
    const root = workspaceRoot();
    if (!root) {
      stream.markdown("Open a folder first — CodeChatter answers questions about the current repo.");
      return;
    }

    const chatOpts = await buildClientOptions(context, chatProvider(), "chat");
    if (!chatOpts) {
      stream.markdown("No chat API key set. Run **CodeChatter: Set API Key**.");
      return;
    }
    const chat = createChatClient(chatOpts);

    // --- git-aware path -----------------------------------------------------
    const gitN = gitRequestCommits(request);
    if (gitN !== undefined) {
      if (!(await isGitRepo(root))) {
        stream.markdown("This workspace isn't a git repository, so I can't inspect commit history.");
        return;
      }
      stream.progress(`Reading the last ${gitN} commits…`);
      const commitsContext = await recentCommitsContext(root, gitN);
      const question = request.prompt.trim() || `Summarize what changed in the last ${gitN} commits.`;
      await streamAnswer(chat, buildGitPrompt(question, commitsContext), stream, token);
      return;
    }

    // --- RAG path -----------------------------------------------------------
    const store = await openStore(context);
    const meta = store ? await store.meta() : undefined;
    if (!store || !meta) {
      stream.markdown("No index yet. Run **CodeChatter: Index Repo** (or click the status bar) first.");
      return;
    }

    const embedOpts = await buildClientOptions(context, embeddingProvider(), "embed");
    if (!embedOpts) return;
    const embedder = createEmbedder(embedOpts);

    if (meta.embeddingModel !== embedder.model) {
      stream.markdown(
        `⚠️ This index was built with **${meta.embeddingModel}** but your embedding model is now ` +
          `**${embedder.model}**. Re-index for accurate results.\n\n`,
      );
    }

    // #file / #folder scoping (PRD v2): if the user attached references, restrict
    // retrieval to those paths.
    const scope = await resolveScope(request, root);
    const filter = scope.hasScope
      ? (p: string) =>
          scope.filePaths.has(p) || scope.dirPrefixes.some((d) => p === d || p.startsWith(d + "/"))
      : undefined;
    if (scope.hasScope) stream.markdown(`_Scoped to: ${scope.labels.join(", ")}_\n\n`);

    // Multi-turn: condense a follow-up into a standalone query so retrieval works
    // for turns like "what about that function?".
    const history = formatHistory(chatContext);
    let embedText = request.prompt;
    if (history) {
      stream.progress("Understanding your question…");
      embedText = await condenseQuestion(chat, history, request.prompt);
    }

    stream.progress("Searching the codebase…");
    const { matches, prompt } = await retrieve(request.prompt, store, embedder, topK(), {
      filter,
      embedText,
      history: history || undefined,
      minScore: minScore(),
    });

    if (matches.length === 0) {
      // Referenced files may not be indexed yet — read them straight from disk.
      if (scope.filePaths.size > 0) {
        const direct = await readFilesDirect(root, [...scope.filePaths]);
        if (direct) {
          await streamAnswer(chat, buildContextPrompt(request.prompt, direct, "Referenced files"), stream, token);
          return;
        }
      }
      stream.markdown(
        scope.hasScope
          ? "I couldn't find anything for that within the referenced path(s)."
          : "I couldn't find anything relevant in the index for that question. Try rephrasing, or index the repo if you haven't.",
      );
      return;
    }

    await streamAnswer(chat, prompt, stream, token);
    renderSources(root, matches, stream);
  };
}

/** Flatten recent chat turns into a compact transcript for condensing/grounding. */
function formatHistory(chatContext: vscode.ChatContext): string {
  const MAX_TURNS = 6;
  const recent = chatContext.history.slice(-MAX_TURNS);
  const lines: string[] = [];
  for (const turn of recent) {
    if (turn instanceof vscode.ChatRequestTurn) {
      lines.push(`User: ${turn.prompt}`);
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((part) =>
          part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : "",
        )
        .join("")
        .trim();
      if (text) lines.push(`Assistant: ${truncate(text, 600)}`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

interface Scope {
  filePaths: Set<string>;
  dirPrefixes: string[];
  labels: string[];
  hasScope: boolean;
}

/** Resolve #file/#folder/#selection references to workspace-relative paths. */
async function resolveScope(request: vscode.ChatRequest, root: string): Promise<Scope> {
  const filePaths = new Set<string>();
  const dirPrefixes: string[] = [];
  const labels: string[] = [];

  for (const ref of request.references) {
    let uri: vscode.Uri | undefined;
    if (ref.value instanceof vscode.Uri) uri = ref.value;
    else if (ref.value instanceof vscode.Location) uri = ref.value.uri;
    if (!uri) continue;

    const rel = toRel(root, uri.fsPath);
    if (rel === undefined) continue;

    try {
      const stat = await fs.stat(uri.fsPath);
      if (stat.isDirectory()) {
        dirPrefixes.push(rel);
        labels.push(rel + "/");
      } else {
        filePaths.add(rel);
        labels.push(rel);
      }
    } catch {
      filePaths.add(rel);
      labels.push(rel);
    }
  }
  return { filePaths, dirPrefixes, labels, hasScope: filePaths.size > 0 || dirPrefixes.length > 0 };
}

/** Read referenced files directly (capped) for the not-indexed fallback. */
async function readFilesDirect(root: string, relPaths: string[]): Promise<string | undefined> {
  let budget = DIRECT_FILE_BUDGET;
  const blocks: string[] = [];
  for (const rel of relPaths) {
    if (budget <= 0) break;
    try {
      const content = await fs.readFile(path.join(root, rel), "utf8");
      const slice = content.slice(0, Math.min(budget, 8000));
      budget -= slice.length;
      blocks.push(`--- ${rel} ---\n${slice}`);
    } catch {
      // unreadable — skip
    }
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/** Workspace-relative POSIX path, or undefined if `fsPath` is outside `root`. */
function toRel(root: string, fsPath: string): string | undefined {
  const rel = path.relative(root, fsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

/** Returns the commit count if this is a git-history request, else undefined. */
function gitRequestCommits(request: vscode.ChatRequest): number | undefined {
  const numeric = request.prompt.match(/\d+/);
  if (request.command === "changes") {
    return numeric ? clampCommits(parseInt(numeric[0], 10)) : 5;
  }
  // Also catch obvious phrasings without the slash command.
  if (/\b(last|recent|past)\b[^.]*\bcommits?\b/i.test(request.prompt)) {
    return numeric ? clampCommits(parseInt(numeric[0], 10)) : 5;
  }
  return undefined;
}

function clampCommits(n: number): number {
  return Math.max(1, Math.min(50, n));
}

async function streamAnswer(
  chat: ReturnType<typeof createChatClient>,
  prompt: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  try {
    for await (const fragment of chat.stream(prompt)) {
      if (token.isCancellationRequested) return;
      stream.markdown(fragment);
    }
  } catch (err) {
    stream.markdown(`\n\n**Error:** ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Render retrieved chunks as clickable file:line anchors (PRD F2). */
function renderSources(root: string, matches: Match[], stream: vscode.ChatResponseStream): void {
  stream.markdown("\n\n**Sources**\n");
  for (const m of matches) {
    const { filePath, startLine, endLine } = m.chunk;
    const uri = vscode.Uri.file(path.join(root, filePath));
    const range = new vscode.Range(Math.max(0, startLine - 1), 0, Math.max(0, endLine - 1), 0);
    stream.anchor(new vscode.Location(uri, range), `${filePath}:${startLine}-${endLine}`);
  }
}
