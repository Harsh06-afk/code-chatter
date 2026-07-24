import { ChatClient, Embedder } from "./types";
import { GeminiChatClient } from "./chat";
import { GeminiEmbedder } from "./embedder";
import { OpenAICompatibleChatClient, OpenAICompatibleEmbedder } from "./openai";
import { AnthropicChatClient } from "./anthropic";

export type ProviderId = "gemini" | "openai" | "deepseek" | "groq" | "anthropic" | "ollama";

interface EmbedInfo {
  defaultModel: string;
  batchSize: number;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  kind: "gemini" | "openai" | "anthropic";
  /** Base URL for OpenAI/Anthropic-shaped providers (unused for Gemini). */
  chatBaseUrl: string;
  defaultChatModel: string;
  embed?: EmbedInfo;
  /**
   * Host that requests to this provider MUST target (PRD §4.2 allowlist).
   * Empty string means the provider allows a custom/self-hosted base URL,
   * which requires explicit user confirmation the first time.
   */
  allowedHost: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  gemini: {
    id: "gemini",
    label: "Gemini (Google)",
    kind: "gemini",
    chatBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultChatModel: "gemini-3.5-flash",
    embed: { defaultModel: "gemini-embedding-001", batchSize: 100 },
    allowedHost: "generativelanguage.googleapis.com",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    chatBaseUrl: "https://api.openai.com/v1",
    defaultChatModel: "gpt-4o-mini",
    embed: { defaultModel: "text-embedding-3-small", batchSize: 100 },
    allowedHost: "api.openai.com",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    chatBaseUrl: "https://api.deepseek.com/v1",
    defaultChatModel: "deepseek-chat",
    allowedHost: "api.deepseek.com",
  },
  groq: {
    id: "groq",
    label: "Groq",
    kind: "openai",
    chatBaseUrl: "https://api.groq.com/openai/v1",
    defaultChatModel: "llama-3.3-70b-versatile",
    allowedHost: "api.groq.com",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    chatBaseUrl: "https://api.anthropic.com",
    defaultChatModel: "claude-haiku-4-5-20251001",
    allowedHost: "api.anthropic.com",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai",
    chatBaseUrl: "http://localhost:11434/v1",
    defaultChatModel: "llama3.1",
    embed: { defaultModel: "nomic-embed-text", batchSize: 50 },
    allowedHost: "", // self-hosted: any host, but requires confirmation
  },
};

export interface ClientOptions {
  provider: ProviderId;
  apiKey: string;
  /** Override the default model. */
  model?: string;
  /** Override the base URL (only honoured for providers that allow custom hosts). */
  baseUrl?: string;
  /** Set true once the user has confirmed a non-allowlisted custom endpoint. */
  customEndpointConfirmed?: boolean;
}

/** Throw unless `url` targets the provider's allowlisted host (PRD §4.2). */
export function assertAllowedEndpoint(info: ProviderInfo, url: string, confirmed: boolean): void {
  const host = new URL(url).hostname;
  if (info.allowedHost) {
    if (host !== info.allowedHost) {
      throw new Error(
        `${info.label} may only call ${info.allowedHost}, not ${host}. Refusing to send your key.`,
      );
    }
    return;
  }
  // Provider permits custom hosts (Ollama/self-hosted): require confirmation.
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (!isLocal && !confirmed) {
    throw new Error(
      `Sending your key to a custom endpoint (${host}) requires explicit confirmation first.`,
    );
  }
}

export function createChatClient(opts: ClientOptions): ChatClient {
  const info = PROVIDERS[opts.provider];
  const model = opts.model ?? info.defaultChatModel;
  const baseUrl = opts.baseUrl ?? info.chatBaseUrl;
  assertAllowedEndpoint(info, baseUrl, !!opts.customEndpointConfirmed);

  switch (info.kind) {
    case "gemini":
      return new GeminiChatClient(opts.apiKey, model);
    case "anthropic":
      return new AnthropicChatClient(opts.apiKey, model, baseUrl);
    case "openai":
      return new OpenAICompatibleChatClient(opts.apiKey, model, baseUrl);
  }
}

export function createEmbedder(opts: ClientOptions): Embedder {
  const info = PROVIDERS[opts.provider];
  if (!info.embed) {
    throw new Error(`${info.label} does not provide an embedding API. Pick another for indexing.`);
  }
  const model = opts.model ?? info.embed.defaultModel;
  const baseUrl = opts.baseUrl ?? info.chatBaseUrl;
  assertAllowedEndpoint(info, baseUrl, !!opts.customEndpointConfirmed);

  if (info.kind === "gemini") return new GeminiEmbedder(opts.apiKey);
  return new OpenAICompatibleEmbedder(opts.apiKey, model, baseUrl, info.embed.batchSize);
}

/** Providers capable of producing embeddings (for the index-time picker). */
export function embeddingProviders(): ProviderInfo[] {
  return Object.values(PROVIDERS).filter((p) => p.embed);
}
