import * as vscode from "vscode";
import * as path from "node:path";
import { createChatClient, createEmbedder } from "../core/providers";
import { retrieve, condenseQuestion, buildGitPrompt } from "../core/retriever";
import { isGitRepo, recentCommitsContext } from "../core/git";
import { openStore, workspaceRoot } from "./storage";
import { buildClientOptions, chatProvider, embeddingProvider, topK, minScore } from "./settings";

/**
 * Fork-friendly Q&A UI (works in Antigravity / Cursor / Windsurf / VSCodium /
 * VS Code). The question is asked via a native input popup; the streamed answer
 * and clickable sources render in a themed webview panel. This is the fallback
 * for editors that don't expose the VS Code Chat Participant API (`@codechatter`).
 */

let panel: vscode.WebviewPanel | undefined;
let ready: Promise<void> = Promise.resolve();
let markReady: () => void = () => {};
let busy = false;

/** Conversation kept while the panel is open, for multi-turn follow-ups. */
const turns: { role: "user" | "assistant"; text: string }[] = [];

/** Open the panel and immediately ask a question, or prompt for one. */
export async function openAskPanel(
  context: vscode.ExtensionContext,
  presetQuestion?: string,
): Promise<void> {
  ensurePanel(context);
  panel!.reveal(vscode.ViewColumn.Beside, true);

  const question = presetQuestion ?? (await promptQuestion());
  if (!question) return;
  await handleAsk(context, question);
}

function ensurePanel(context: vscode.ExtensionContext): void {
  if (panel) return;

  ready = new Promise((res) => (markReady = res));
  turns.length = 0;

  panel = vscode.window.createWebviewPanel(
    "codechatter.ask",
    "CodeChatter",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = getHtml(panel.webview);

  panel.onDidDispose(() => {
    panel = undefined;
    turns.length = 0;
  });

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "ready") markReady();
    else if (msg?.type === "open") openSource(msg.file, msg.startLine, msg.endLine);
    else if (msg?.type === "followup") {
      const q = await promptQuestion();
      if (q) await handleAsk(context, q);
    }
  });
}

function promptQuestion(): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: "Ask CodeChatter",
    prompt: "Ask a question about this repository",
    placeHolder: "e.g. where is the API key stored?  ·  /changes 5",
    ignoreFocusOut: true,
  });
}

async function handleAsk(context: vscode.ExtensionContext, question: string): Promise<void> {
  if (busy) {
    vscode.window.showInformationMessage("CodeChatter is still answering — one moment.");
    return;
  }
  busy = true;
  try {
    await ready;
    post({ type: "user", text: question });
    post({ type: "assistantStart" });

    const root = workspaceRoot();
    if (!root) return end("Open a folder first — CodeChatter answers questions about the current repo.");

    const chatOpts = await buildClientOptions(context, chatProvider(), "chat");
    if (!chatOpts) return end("No chat API key set. Run **CodeChatter: Set API Key**.");
    const chat = createChatClient(chatOpts);

    // --- git-aware path: "/changes N" or "...last N commits" ---
    const gitN = gitRequestCommits(question);
    if (gitN !== undefined) {
      if (!(await isGitRepo(root))) return end("This workspace isn't a git repository.");
      post({ type: "status", text: `Reading the last ${gitN} commits…` });
      const commitsContext = await recentCommitsContext(root, gitN);
      const q = question.replace(/^\/changes\b/i, "").trim() || `Summarize the last ${gitN} commits.`;
      await streamInto(chat, buildGitPrompt(q, commitsContext), question);
      return;
    }

    // --- RAG path ---
    const store = await openStore(context);
    const meta = store ? await store.meta() : undefined;
    if (!store || !meta) {
      return end("No index yet. Run **CodeChatter: Index Repo** (or click the status bar) first.");
    }

    const embedOpts = await buildClientOptions(context, embeddingProvider(), "embed");
    if (!embedOpts) return end("No embedding API key set. Run **CodeChatter: Set API Key**.");
    const embedder = createEmbedder(embedOpts);

    const history = formatHistory();
    let embedText = question;
    if (history) {
      post({ type: "status", text: "Understanding your question…" });
      embedText = await condenseQuestion(chat, history, question);
    }

    post({ type: "status", text: "Searching the codebase…" });
    const { matches, prompt } = await retrieve(question, store, embedder, topK(), {
      embedText,
      history: history || undefined,
      minScore: minScore(),
    });

    if (matches.length === 0) {
      return end(
        "I couldn't find anything relevant in the index for that. Try rephrasing, or index the repo if you haven't.",
      );
    }

    const sources = matches.map((m) => ({
      file: m.chunk.filePath,
      startLine: m.chunk.startLine,
      endLine: m.chunk.endLine,
    }));
    await streamInto(chat, prompt, question, sources);
  } finally {
    busy = false;
  }
}

/** Stream an answer into the current assistant bubble, then record the turn. */
async function streamInto(
  chat: ReturnType<typeof createChatClient>,
  prompt: string,
  question: string,
  sources?: { file: string; startLine: number; endLine: number }[],
): Promise<void> {
  let answer = "";
  try {
    for await (const fragment of chat.stream(prompt)) {
      answer += fragment;
      post({ type: "chunk", text: fragment });
    }
  } catch (err) {
    post({ type: "chunk", text: `\n\n**Error:** ${err instanceof Error ? err.message : String(err)}` });
  }
  if (sources && sources.length) post({ type: "sources", items: sources });
  post({ type: "end" });
  turns.push({ role: "user", text: question });
  turns.push({ role: "assistant", text: answer });
}

/** Finish the current answer with a single markdown message (no streaming). */
function end(message: string): void {
  post({ type: "chunk", text: message });
  post({ type: "end" });
}

function formatHistory(): string {
  const recent = turns.slice(-6);
  return recent
    .map((t) => (t.role === "user" ? `User: ${t.text}` : `Assistant: ${truncate(t.text, 600)}`))
    .join("\n");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function openSource(file: string, startLine: number, endLine: number): Promise<void> {
  const root = workspaceRoot();
  if (!root) return;
  try {
    const uri = vscode.Uri.file(path.join(root, file));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const range = new vscode.Range(Math.max(0, startLine - 1), 0, Math.max(0, endLine - 1), 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch {
    vscode.window.showWarningMessage(`Couldn't open ${file}.`);
  }
}

/** Returns the commit count if this is a git-history request, else undefined. */
function gitRequestCommits(question: string): number | undefined {
  const numeric = question.match(/\d+/);
  if (/^\/changes\b/i.test(question.trim())) {
    return numeric ? clampCommits(parseInt(numeric[0], 10)) : 5;
  }
  if (/\b(last|recent|past)\b[^.]*\bcommits?\b/i.test(question)) {
    return numeric ? clampCommits(parseInt(numeric[0], 10)) : 5;
  }
  return undefined;
}

function clampCommits(n: number): number {
  return Math.max(1, Math.min(50, n));
}

function post(message: unknown): void {
  panel?.webview.postMessage(message);
}

function getHtml(webview: vscode.Webview): string {
  const nonce = String(Math.random()).slice(2);
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column; height: 100vh;
  }
  #messages { flex: 1; overflow-y: auto; padding: 16px; }
  .turn { margin-bottom: 18px; }
  .role { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; opacity: .6; margin-bottom: 4px; }
  .user .bubble {
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.1));
    border-left: 3px solid var(--vscode-textLink-foreground);
    padding: 8px 12px; border-radius: 4px; white-space: pre-wrap;
  }
  .assistant .bubble { line-height: 1.5; }
  .bubble p { margin: 0 0 10px; }
  .bubble h1,.bubble h2,.bubble h3 { margin: 12px 0 6px; }
  .bubble ul { margin: 6px 0; padding-left: 20px; }
  .bubble code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: rgba(127,127,127,.18); padding: 1px 4px; border-radius: 3px; font-size: .92em;
  }
  .bubble pre.code {
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12));
    padding: 10px 12px; border-radius: 6px; overflow-x: auto;
  }
  .bubble pre.code code { background: none; padding: 0; }
  .bubble a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .status { opacity: .6; font-style: italic; }
  .sources { margin-top: 10px; }
  .sources-label { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; opacity: .6; margin-bottom: 6px; }
  .src {
    display: inline-block; margin: 0 6px 6px 0; padding: 3px 9px;
    background: var(--vscode-badge-background, rgba(127,127,127,.2));
    color: var(--vscode-badge-foreground, inherit);
    border-radius: 10px; font-size: 12px; cursor: pointer;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .src:hover { outline: 1px solid var(--vscode-textLink-foreground); }
  footer { padding: 10px 16px; border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,.2)); }
  #ask {
    width: 100%; box-sizing: border-box; padding: 8px 14px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; font-size: 13px;
  }
  #ask:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  #empty { opacity: .55; text-align: center; margin-top: 40px; padding: 0 24px; line-height: 1.6; }
</style>
</head>
<body>
  <div id="messages"><div id="empty">Ask a question about this repository.<br/>Answers are grounded in your indexed code, with clickable sources.</div></div>
  <footer><button id="ask">Ask a question</button></footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById("messages");
  const empty = document.getElementById("empty");
  let current = null, buffer = "";

  document.getElementById("ask").addEventListener("click", () => vscode.postMessage({ type: "followup" }));

  function esc(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function renderMd(src){
    const blocks = [];
    src = src.replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g, (m,lang,code) => {
      blocks.push('<pre class="code"><code>' + esc(code.replace(/\\n$/,"")) + '</code></pre>');
      return "\\u0000" + (blocks.length-1) + "\\u0000";
    });
    src = esc(src);
    src = src.replace(/^###\\s?(.*)$/gm,"<h3>$1</h3>")
             .replace(/^##\\s?(.*)$/gm,"<h2>$1</h2>")
             .replace(/^#\\s?(.*)$/gm,"<h1>$1</h1>");
    src = src.replace(/\`([^\`]+)\`/g,"<code>$1</code>");
    src = src.replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>");
    src = src.replace(/\\*([^*]+)\\*/g,"<em>$1</em>");
    src = src.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2">$1</a>');
    src = src.replace(/(?:^[-*]\\s.*(?:\\n|$))+/gm, m => {
      const items = m.trim().split(/\\n/).map(l => "<li>" + l.replace(/^[-*]\\s/,"") + "</li>").join("");
      return "<ul>" + items + "</ul>";
    });
    src = src.replace(/\\n/g,"<br>");
    src = src.replace(/<br>\\s*(<\\/?(?:h[1-6]|ul|li|pre)[^>]*>)/g,"$1");
    src = src.replace(/(<\\/(?:h[1-6]|ul|li|pre)>)\\s*<br>/g,"$1");
    src = src.replace(/\\u0000(\\d+)\\u0000/g,(m,i)=>blocks[+i]);
    return src;
  }

  function scrollDown(){ messages.scrollTop = messages.scrollHeight; }

  function addTurn(role){
    if (empty) empty.remove();
    const wrap = document.createElement("div");
    wrap.className = "turn " + role;
    const label = document.createElement("div");
    label.className = "role";
    label.textContent = role === "user" ? "You" : "CodeChatter";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    wrap.appendChild(label); wrap.appendChild(bubble);
    messages.appendChild(wrap);
    scrollDown();
    return bubble;
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "user") { addTurn("user").textContent = m.text; }
    else if (m.type === "assistantStart") { current = addTurn("assistant"); buffer = ""; }
    else if (m.type === "status") { if (current) current.innerHTML = '<span class="status">' + esc(m.text) + "</span>"; scrollDown(); }
    else if (m.type === "chunk") { buffer += m.text; if (current) current.innerHTML = renderMd(buffer); scrollDown(); }
    else if (m.type === "sources") {
      if (!current) return;
      const box = document.createElement("div");
      box.className = "sources";
      box.innerHTML = '<div class="sources-label">Sources</div>';
      m.items.forEach(s => {
        const chip = document.createElement("span");
        chip.className = "src";
        chip.textContent = s.file + ":" + s.startLine + "-" + s.endLine;
        chip.addEventListener("click", () => vscode.postMessage({ type: "open", file: s.file, startLine: s.startLine, endLine: s.endLine }));
        box.appendChild(chip);
      });
      current.appendChild(box); scrollDown();
    }
    else if (m.type === "end") { current = null; }
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
