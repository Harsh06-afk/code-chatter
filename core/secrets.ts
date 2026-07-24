// Lightweight secret scan applied to chunks before embedding (PRD §4.4).
// Goal: avoid shipping obvious credentials to the embedding API. Not a full
// secret scanner — a cheap safety net layered on top of the file-level excludes.

const SECRET_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/, // AWS temporary access key id
  /\bAIza[0-9A-Za-z\-_]{35}\b/, // Google API key
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style secret key
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, // PEM private keys
  /\bghp_[A-Za-z0-9]{36}\b/, // GitHub personal access token
];

/** True if the text appears to contain a hard-coded secret. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}
