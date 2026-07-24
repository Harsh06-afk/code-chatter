import * as vscode from "vscode";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { JsonVectorStore } from "../core/store";

/** Absolute path of the active workspace root, or undefined if none is open. */
export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Index location: per-workspace folder inside the extension's globalStorage
 * (PRD §4.3 — vectors + chunks live only on disk, never uploaded). Keyed by a
 * hash of the workspace path so multiple repos don't collide.
 */
export function indexFilePath(context: vscode.ExtensionContext): string | undefined {
  const root = workspaceRoot();
  if (!root) return undefined;
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(context.globalStorageUri.fsPath, id, "index.json");
}

export async function openStore(context: vscode.ExtensionContext): Promise<JsonVectorStore | undefined> {
  const file = indexFilePath(context);
  if (!file) return undefined;
  return JsonVectorStore.open(file);
}

/** True if an index file exists for the current workspace. */
export async function indexExists(context: vscode.ExtensionContext): Promise<boolean> {
  const file = indexFilePath(context);
  if (!file) return false;
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Delete the current workspace's index (PRD §4.3 "Delete Index"). */
export async function deleteIndex(context: vscode.ExtensionContext): Promise<void> {
  const file = indexFilePath(context);
  if (!file) return;
  await fs.rm(path.dirname(file), { recursive: true, force: true });
}
