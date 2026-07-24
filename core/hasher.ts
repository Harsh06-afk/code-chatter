import { createHash } from "node:crypto";

/** SHA-256 of a file's contents, hex-encoded. Used for stale detection (PRD F3). */
export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
