import * as vscode from "vscode";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { hashContent } from "../core/hasher";
import { openStore, workspaceRoot } from "./storage";
import { StatusBar } from "./statusBar";

/** Workspace-relative POSIX path, or undefined if `fsPath` is outside `root`. */
function toRel(root: string, fsPath: string): string | undefined {
  const rel = path.relative(root, fsPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

/**
 * Wire incremental staleness detection (PRD F3):
 *  - on save: rehash the file, mark stale if it differs from the indexed hash
 *  - on .git/HEAD change (branch switch / pull): rehash all indexed files
 */
export function registerWatchers(context: vscode.ExtensionContext, status: StatusBar): void {
  const root = workspaceRoot();
  if (!root) return;

  const onSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    const rel = toRel(root, doc.uri.fsPath);
    if (!rel) return;
    const store = await openStore(context);
    if (!store) return;
    const hashes = await store.fileHashes();
    if (hashes.size === 0) return; // repo not indexed yet
    try {
      const content = await fs.readFile(doc.uri.fsPath, "utf8");
      const stored = hashes.get(rel);
      if (stored === undefined || stored !== hashContent(content)) status.markStale(rel);
    } catch {
      status.markStale(rel);
    }
  });

  // .git/HEAD changes on checkout / pull / branch switch.
  const gitWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, ".git/HEAD"),
  );
  const onHead = () => recomputeStale(context, status, root);
  gitWatcher.onDidChange(onHead);
  gitWatcher.onDidCreate(onHead);

  context.subscriptions.push(onSave, gitWatcher);
}

/** Rehash every indexed file against disk and mark those that changed. */
async function recomputeStale(
  context: vscode.ExtensionContext,
  status: StatusBar,
  root: string,
): Promise<void> {
  const store = await openStore(context);
  if (!store) return;
  const hashes = await store.fileHashes();
  for (const [rel, stored] of hashes) {
    try {
      const content = await fs.readFile(path.join(root, rel), "utf8");
      if (hashContent(content) !== stored) status.markStale(rel);
    } catch {
      status.markStale(rel); // file deleted since indexing
    }
  }
}
