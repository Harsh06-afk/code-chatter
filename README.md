# CodeChatter

**Understand any repo in minutes, for free.** Index your codebase once with your own free API key, then ask unlimited questions for a fraction of a cent — no subscription, and your index never leaves your machine.

CodeChatter is a local-first, bring-your-own-key (BYOK) chat assistant for your codebase. It runs entirely from your machine against your chosen provider's official API — no backend, no accounts, no telemetry.

---

## Features

- **`@codechatter` in the chat panel** — ask questions about the current repo; answers cite clickable `file:line` sources.
- **One-time local indexing** — walks your workspace, chunks code along function/class boundaries (tree-sitter), embeds it, and stores vectors on your disk.
- **Incremental re-index** — a SHA-256 per file means only changed files are re-embedded on save, branch switch, or pull. A status-bar indicator shows how many files are stale.
- **Git-aware questions** — `@codechatter /changes 5` summarizes what changed in the last 5 commits (diffs are read on demand, never embedded).
- **Repo Tour** — generate a one-page onboarding doc (entry points, key modules, data flow).
- **Explain with repo context** — right-click a selection to ask about it with repo context.
- **Multi-provider BYOK** — chat with Gemini (default), OpenAI, DeepSeek, Groq, Anthropic, or local Ollama. Embed with Gemini, OpenAI, or Ollama.

## Quick start

1. Install the extension.
2. Run **CodeChatter: Set API Key** and paste a key (a free [Gemini API key](https://aistudio.google.com/apikey) works).
3. Run **CodeChatter: Index Repo** (or click the status-bar item). You'll see a cost estimate first.
4. Open the chat panel and ask: `@codechatter where is the auth middleware defined?`

## Commands

| Command | What it does |
|---|---|
| CodeChatter: Index Repo | Build/refresh the index (shows a cost estimate first). |
| CodeChatter: Re-index Changed Files | Re-embed only files changed since last index. |
| CodeChatter: Delete Index | Wipe this workspace's index from disk. |
| CodeChatter: Set API Key | Store a provider key in your OS keychain. |
| CodeChatter: Repo Tour | Generate an onboarding guide for the repo. |
| CodeChatter: Explain with Repo Context | Explain the current selection (right-click). |

Chat slash command: `@codechatter /changes [N]` — answer from the last N commits.

## Settings

- `codechatter.chatProvider` — provider used to answer questions (default `gemini`).
- `codechatter.chatModel` — override the chat model id (blank = provider default).
- `codechatter.embeddingProvider` — provider used to build the index. **Locked per repo**: changing it requires a full re-index (vector spaces aren't compatible across providers).
- `codechatter.topK` — how many code chunks to retrieve per question (default 8).
- `codechatter.customBaseUrl` — custom/self-hosted (Ollama) endpoint; requires confirmation before your key is sent.

---

## Security & privacy — "What gets sent?"

CodeChatter is designed so you can see exactly what leaves your machine.

- **At index time:** the text of each code chunk is sent to your chosen **embedding** provider. That's it.
- **At ask time:** your question plus the top-8 retrieved chunks are sent to your chosen **chat** provider.
- **Never sent:** your whole repo, file paths outside the prompt, or anything to us — there is no CodeChatter server.

Protections:

- **Keys** live only in VS Code `SecretStorage` (your OS keychain) — never in `settings.json`, never in the index, never logged.
- **Endpoint allowlist:** each key is only ever sent to that provider's official HTTPS endpoint (e.g. `generativelanguage.googleapis.com`, `api.openai.com`). A custom/self-hosted base URL requires an explicit one-time confirmation.
- **Secret hygiene:** files like `.env*`, `*.pem`, `*.key`, `id_rsa*`, and `credentials*` are never indexed, and a secret-pattern scan drops any chunk that looks like it contains a credential *before* it is embedded.
- **Index locality:** vectors and chunks are stored only in the extension's local storage. **Delete Index** wipes them.
- **No telemetry.**
- **Prompt-injection:** retrieved code is passed to the model as *data*; the system prompt instructs it to ignore any instructions found inside your files.

## License

MIT — see [LICENSE](./LICENSE).
