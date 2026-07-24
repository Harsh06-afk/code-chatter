import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Per-diff character budget so we never blow the model's context window. */
const MAX_DIFF_CHARS = 12000;

export interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  date: string; // ISO-ish, from git
  subject: string;
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(" ")} failed: ${msg}`);
  }
}

/** True if `root` is inside a git work tree. */
export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const out = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** The most recent `n` commits (metadata only). */
export async function recentCommits(root: string, n: number): Promise<Commit[]> {
  // Unit separator between fields, record separator between commits — safe against
  // any character that can appear in a commit subject.
  const fmt = ["%H", "%h", "%an", "%ad", "%s"].join("%x1f") + "%x1e";
  const out = await git(root, [
    "log",
    `-n${n}`,
    "--date=short",
    `--pretty=format:${fmt}`,
  ]);
  return out
    .split("\x1e")
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [hash, shortHash, author, date, subject] = rec.split("\x1f");
      return { hash, shortHash, author, date, subject };
    });
}

/** Unified diff for a single commit (against its first parent). */
export async function commitDiff(root: string, ref: string): Promise<string> {
  return git(root, ["show", "--no-color", "--stat", "--patch", ref]);
}

/** Files touched across the last `n` commits, deduplicated. */
export async function changedFiles(root: string, n: number): Promise<string[]> {
  const out = await git(root, ["log", `-n${n}`, "--name-only", "--pretty=format:"]);
  const files = new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return [...files].sort();
}

/**
 * Build an LLM context block describing the last `n` commits: metadata plus each
 * commit's diff, truncated to a char budget. This is fetched on demand and NOT
 * embedded — diffs are cheap and change constantly (PRD v2: git-aware questions).
 */
export async function recentCommitsContext(root: string, n: number): Promise<string> {
  const commits = await recentCommits(root, n);
  if (commits.length === 0) return "(no commits found)";

  const blocks: string[] = [];
  for (const c of commits) {
    let diff = await commitDiff(root, c.hash);
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + "\n… (diff truncated)";
    }
    blocks.push(
      `commit ${c.shortHash} — ${c.subject}\nauthor: ${c.author}   date: ${c.date}\n\n${diff}`,
    );
  }
  return blocks.join("\n\n========================================\n\n");
}
