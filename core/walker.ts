import { promises as fs } from "node:fs";
import * as path from "node:path";
import ignore, { Ignore } from "ignore";
import { INDEX } from "./config";

/** Directories we never descend into, regardless of ignore files. */
const HARD_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".codechatter",
]);

/**
 * Secret / non-source files hard-excluded from indexing (PRD §4.4).
 * These are gitignore-style globs applied to the workspace-relative path.
 */
const HARD_EXCLUDE_GLOBS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "credentials*",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
];

/** File extensions that are almost certainly binary; skipped without reading. */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg", ".tiff",
  ".pdf", ".zip", ".gz", ".tar", ".rar", ".7z", ".jar", ".war",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".class",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac", ".ogg", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".wasm", ".node", ".pyc", ".pdb", ".lockb",
]);

export interface WalkResult {
  /** Workspace-relative POSIX paths of indexable files. */
  files: string[];
  /** Files skipped for being too large, with their sizes. */
  skippedLarge: string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Load ignore rules from .gitignore + .chatterignore if present. */
async function loadIgnore(root: string): Promise<Ignore> {
  const ig = ignore();
  ig.add(HARD_EXCLUDE_GLOBS);
  for (const name of [".gitignore", ".chatterignore"]) {
    try {
      const content = await fs.readFile(path.join(root, name), "utf8");
      ig.add(content);
    } catch {
      // no such ignore file — fine
    }
  }
  return ig;
}

/** Cheap binary sniff: NUL byte in the first 8 KB means "not text". */
async function looksBinary(absPath: string): Promise<boolean> {
  const handle = await fs.open(absPath, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, 8192, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * Walk `root`, returning indexable source files (PRD F5).
 * Applies hard-excluded dirs, ignore rules, size cap, and binary detection.
 */
export async function walk(root: string): Promise<WalkResult> {
  const ig = await loadIgnore(root);
  const files: string[] = [];
  const skippedLarge: string[] = [];

  async function recurse(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));

      if (entry.isDirectory()) {
        if (HARD_EXCLUDE_DIRS.has(entry.name)) continue;
        // gitignore matches directories with a trailing slash
        if (ig.ignores(rel + "/")) continue;
        await recurse(abs);
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks, sockets, etc.
      if (ig.ignores(rel)) continue;
      if (BINARY_EXTS.has(path.extname(entry.name).toLowerCase())) continue;

      const stat = await fs.stat(abs);
      if (stat.size > INDEX.maxFileBytes) {
        skippedLarge.push(rel);
        continue;
      }
      if (stat.size === 0) continue;
      if (await looksBinary(abs)) continue;

      files.push(rel);
    }
  }

  await recurse(root);
  files.sort();
  return { files, skippedLarge };
}
