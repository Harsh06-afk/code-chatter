import * as vscode from "vscode";
import { indexExists } from "./storage";

/**
 * Status bar indicator (PRD F6): shows index state and stale-file count, and is
 * click-to-(re)index. Also the single source of truth for which files have
 * changed since the last index.
 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly stale = new Set<string>();
  private hasIndex = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(this.item);
  }

  /** Files (workspace-relative) changed since the last index. */
  get staleFiles(): string[] {
    return [...this.stale];
  }

  markStale(relPath: string): void {
    this.stale.add(relPath);
    this.render();
  }

  clearStale(): void {
    this.stale.clear();
    this.render();
  }

  async refresh(): Promise<void> {
    this.hasIndex = await indexExists(this.context);
    if (!this.hasIndex) this.stale.clear();
    this.render();
  }

  private render(): void {
    if (!this.hasIndex) {
      this.item.text = "$(database) Index repo";
      this.item.tooltip = "CodeChatter: no index yet — click to index this repo";
      this.item.command = "codechatter.indexRepo";
    } else if (this.stale.size === 0) {
      this.item.text = "$(check) CodeChatter";
      this.item.tooltip = "CodeChatter: index up to date";
      this.item.command = "codechatter.indexRepo";
    } else {
      const n = this.stale.size;
      this.item.text = `$(sync) ${n} file${n === 1 ? "" : "s"} stale`;
      this.item.tooltip = "CodeChatter: click to re-index changed files";
      this.item.command = "codechatter.reindex";
    }
    this.item.show();
  }
}
