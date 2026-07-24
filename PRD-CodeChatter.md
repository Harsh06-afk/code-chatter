# PRD — CodeChatter (working name)

**One-liner:** Understand any repo in minutes, for free. Index your codebase once with your own free API key, then ask unlimited questions for a fraction of a cent — no subscription, index never leaves your machine.

**Target user:** Cost-conscious developers (students, indie devs, devs onboarding onto unfamiliar codebases) who won't pay for Copilot/Cursor but have a free Gemini API key.

**Platform:** VS Code extension (also installable in Cursor, Windsurf, VSCodium). JetBrains = future, out of scope for v1. Core logic kept IDE-agnostic in a separate `core/` module to enable this later.

---

## 1. Features

### v1 (MVP)
| # | Feature | Description |
|---|---------|-------------|
| F1 | One-time indexing | Command: "CodeChatter: Index Repo". Walks workspace, chunks code, embeds, stores locally. Progress bar + cost estimate shown before starting. |
| F2 | Chat participant | `@codechatter <question>` in VS Code's native chat panel. Answers cite file paths + line ranges as clickable links. |
| F3 | Incremental re-index | SHA-256 hash per file stored in index. On save / git pull / branch switch, only changed files re-embedded. |
| F4 | Multi-provider BYOK | User adds API key(s) for any provider. **Chat model:** freely selectable & switchable — Gemini, OpenAI, DeepSeek, Anthropic, Groq, Ollama (one OpenAI-compatible client covers most; Gemini/Anthropic get adapters). Default: Gemini Flash (free tier). **Embedding model:** chosen once per repo at index time (Gemini default, OpenAI optional); stored in index metadata; changing it triggers a full re-index warning (vector spaces are incompatible across providers). |
| F5 | Ignore rules | Respects `.gitignore` + optional `.chatterignore`. Never indexes: `node_modules`, lockfiles, `.env*`, binaries, files > 1 MB. |
| F6 | Status bar | "✓ Indexed · 3 files stale" indicator with click-to-reindex. |

### v2 (post-launch)
- **Repo Tour**: one command generates onboarding doc (entry points, key modules, data flow).
- Right-click "Explain with repo context".
- `@file` / `@folder` scoping in questions.
- Git-aware questions ("what changed in last 5 commits?").

### Explicit non-goals (v1)
Autocomplete, code editing/agent mode, JetBrains, cloud sync, telemetry.

---

## 2. Implementation

### Architecture
```
extension/          → VS Code glue only (commands, chat UI, settings)
core/               → IDE-agnostic logic
  ├── walker.ts     → file discovery + ignore rules
  ├── chunker.ts    → tree-sitter (web-tree-sitter) AST chunking;
  │                   fallback: 60-line sliding window for unknown langs
  ├── hasher.ts     → SHA-256 per file → stale detection
  ├── embedder.ts   → Gemini embedding calls, batched (100 chunks/req)
  ├── store.ts      → LanceDB, saved in extension globalStorage dir
  └── retriever.ts  → embed query → top-k=8 cosine search → build prompt
```

### Flows
**Indexing (once):** walk files → filter via ignore rules → chunk by function/class → batch-embed via Gemini → write `{chunk, vector, filePath, startLine, endLine, fileHash}` rows to LanceDB.

**Question:** embed query (1 tiny call) → local vector search (free, <50 ms) → prompt = system instructions + top 8 chunks + question → Gemini Flash → stream answer into chat panel with file links.

**Re-index:** on `onDidSaveTextDocument` + a `.git/HEAD` file watcher → rehash changed files → delete old rows for that file → re-embed only those chunks.

### Tech stack
- TypeScript, VS Code Extension API (`vscode.chat` Chat Participant API)
- `web-tree-sitter` + language grammars (ts/js/py/java/go to start)
- LanceDB (embedded, no server) — index lives on user's disk
- Published to VS Code Marketplace + Open VSX (both free)

---

## 3. APIs used
| Purpose | API | Cost |
|---|---|---|
| Embeddings | Gemini embedding API (default, free tier) or OpenAI embeddings — locked per index (verify current model names at build time) | Free tier / fractions of a cent per repo |
| Answers | Any BYOK provider: Gemini Flash (default), OpenAI, DeepSeek, Anthropic, Groq, local Ollama. One OpenAI-compatible client (`baseURL + key + model`) covers most providers | Free tier / ~₹0.01–0.10 per question |
| Everything else | None — no backend, no server, no accounts | ₹0 |

No proxy server in v1: the extension calls each provider's official endpoint directly from the user's machine with the user's own key.

---

## 4. Security (BYOK + data)
1. **Key storage:** one key per provider, all in VS Code `SecretStorage` API (OS keychain: Keychain/DPAPI/libsecret), keyed by provider name. **Never** in settings.json, never in the index, never logged.
2. **Key scope:** each key exists only in memory during a request and is sent only to that provider's official endpoint over HTTPS (e.g. `generativelanguage.googleapis.com`, `api.openai.com`, `api.deepseek.com`, `api.anthropic.com`). Maintain a hardcoded endpoint allowlist — custom base URLs (for Ollama/self-hosted) require an explicit user confirmation the first time.
3. **Index locality:** vectors + chunks stored only in local globalStorage. Nothing uploaded anywhere. "Delete Index" command wipes it.
4. **Secret hygiene:** hard-exclude `.env*`, `*.pem`, `*.key`, `credentials*`, `id_rsa*` from indexing; run a simple secret-pattern scan (API-key regexes) on chunks before embedding and skip matches — prevents accidentally sending secrets to the embedding API.
5. **Transparency:** a "What gets sent?" doc in README: only (a) chunk text at index time, (b) question + top-8 chunks at ask time. Never the whole repo, never file paths outside prompts.
6. **No telemetry** in v1. If added later: opt-in only, anonymous counts only.
7. **Prompt-injection note:** repo files are untrusted input; system prompt instructs the model to treat retrieved code as data, not instructions.

---

## 5. Success criteria (v1)
- Index a 2k-file repo in < 3 min on a low-end laptop.
- Answer latency < 6 s; per-question cost < ₹0.15 (or free tier).
- Re-index after a typical git pull touches < 5% of embedding cost.
- 100 Marketplace installs in first month; ≥ 1 piece of unsolicited positive feedback.

## 6. Build order
Week 1: walker + hasher + chunker (plain line-based first) → Week 2: embeddings + LanceDB + retrieval CLI test → Week 3: chat participant UI + SecretStorage settings → Week 4: incremental re-index + status bar → polish, README, publish.
