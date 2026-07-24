import * as vscode from "vscode";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { createChatHandler } from "./chatParticipant";
import { runIndex } from "./indexing";
import { promptForApiKey } from "./keys";
import { StatusBar } from "./statusBar";
import { registerWatchers } from "./watchers";
import { generateRepoTour } from "./repoTour";
import { openAskPanel } from "./askPanel";
import { deleteIndex, workspaceRoot } from "./storage";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // globalStorage must exist before we write the index there.
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });

  const status = new StatusBar(context);
  await status.refresh();
  registerWatchers(context, status);

  // Chat participant: @codechatter (only where the host exposes the Chat API;
  // forks like Antigravity/Cursor/Windsurf don't, so the Ask panel is the path there).
  if (typeof vscode.chat?.createChatParticipant === "function") {
    try {
      const participant = vscode.chat.createChatParticipant("codechatter.chat", createChatHandler(context));
      participant.iconPath = new vscode.ThemeIcon("comment-discussion");
      context.subscriptions.push(participant);
    } catch {
      // Host advertises the API but doesn't support registration — ignore.
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("codechatter.ask", () => openAskPanel(context)),
    vscode.commands.registerCommand("codechatter.indexRepo", () => runIndex(context, status, false)),
    vscode.commands.registerCommand("codechatter.reindex", () => runIndex(context, status, true)),
    vscode.commands.registerCommand("codechatter.setApiKey", () => promptForApiKey(context.secrets)),
    vscode.commands.registerCommand("codechatter.deleteIndex", () => confirmDeleteIndex(context, status)),
    vscode.commands.registerCommand("codechatter.explainSelection", () => explainSelection(context)),
    vscode.commands.registerCommand("codechatter.repoTour", () => generateRepoTour(context)),
  );
}

export function deactivate(): void {
  // Disposables are cleaned up via context.subscriptions.
}

async function confirmDeleteIndex(context: vscode.ExtensionContext, status: StatusBar): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Delete the CodeChatter index for this workspace? This cannot be undone.",
    { modal: true },
    "Delete",
  );
  if (choice !== "Delete") return;
  await deleteIndex(context);
  await status.refresh();
  vscode.window.showInformationMessage("CodeChatter: index deleted.");
}

/**
 * "Explain with repo context" (PRD v2): open the Ask panel pre-loaded with a
 * question about the current selection, answered with retrieved repo context.
 */
async function explainSelection(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const root = workspaceRoot();
  if (!editor || editor.selection.isEmpty || !root) {
    vscode.window.showInformationMessage("Select some code first.");
    return;
  }
  const code = editor.document.getText(editor.selection);
  const rel = path.relative(root, editor.document.uri.fsPath).split(path.sep).join("/");
  const query = `Explain this code from \`${rel}\` and how it fits into the repo:\n\n\`\`\`\n${code}\n\`\`\``;
  await openAskPanel(context, query);
}
