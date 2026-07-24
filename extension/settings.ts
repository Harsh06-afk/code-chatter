import * as vscode from "vscode";
import { ClientOptions, ProviderId } from "../core/providers";
import { getKey } from "./keys";

/** Read the CodeChatter settings block. */
function cfg() {
  return vscode.workspace.getConfiguration("codechatter");
}

export function chatProvider(): ProviderId {
  return cfg().get<ProviderId>("chatProvider", "gemini");
}

export function embeddingProvider(): ProviderId {
  return cfg().get<ProviderId>("embeddingProvider", "gemini");
}

export function topK(): number {
  return cfg().get<number>("topK", 8);
}

export function minScore(): number {
  return cfg().get<number>("minScore", 0.55);
}

function customBaseUrl(): string {
  return cfg().get<string>("customBaseUrl", "").trim();
}

function modelOverride(): string {
  return cfg().get<string>("chatModel", "").trim();
}

const CONFIRMED_ENDPOINT_KEY = "codechatter.confirmedEndpoint";

/**
 * Build ClientOptions for a provider, pulling the key from SecretStorage.
 * Returns undefined (after warning) if no key is stored for a provider that needs
 * one, or if the user declines a custom endpoint.
 */
export async function buildClientOptions(
  context: vscode.ExtensionContext,
  provider: ProviderId,
  role: "chat" | "embed",
): Promise<ClientOptions | undefined> {
  const key = (await getKey(context.secrets, provider)) ?? "";
  if (!key && provider !== "ollama") {
    vscode.window.showWarningMessage(
      `No API key set for ${provider}. Run "CodeChatter: Set API Key" first.`,
    );
    return undefined;
  }

  const opts: ClientOptions = { provider, apiKey: key };
  if (role === "chat" && modelOverride()) opts.model = modelOverride();

  const custom = customBaseUrl();
  if (custom && provider === "ollama") {
    opts.baseUrl = custom;
    if (!isLocalUrl(custom)) {
      // Non-local custom endpoint: explicit one-time consent before the key goes out (PRD §4.2).
      if (!(await confirmCustomEndpoint(context, custom))) return undefined;
      opts.customEndpointConfirmed = true;
    }
  }

  return opts;
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

async function confirmCustomEndpoint(context: vscode.ExtensionContext, url: string): Promise<boolean> {
  if (context.globalState.get<string>(CONFIRMED_ENDPOINT_KEY) === url) return true;
  const choice = await vscode.window.showWarningMessage(
    `CodeChatter will send your API key to a custom endpoint: ${url}. Only allow endpoints you trust.`,
    { modal: true },
    "Allow",
  );
  if (choice === "Allow") {
    await context.globalState.update(CONFIRMED_ENDPOINT_KEY, url);
    return true;
  }
  return false;
}
