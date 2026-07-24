import * as vscode from "vscode";
import { PROVIDERS, ProviderId } from "../core/providers";

/**
 * API keys live only in VS Code SecretStorage (OS keychain), keyed by provider
 * (PRD §4.1). Never in settings.json, never logged, never in the index.
 */
const KEY_PREFIX = "codechatter.key.";

export async function getKey(secrets: vscode.SecretStorage, provider: ProviderId): Promise<string | undefined> {
  return secrets.get(KEY_PREFIX + provider);
}

export async function setKey(secrets: vscode.SecretStorage, provider: ProviderId, key: string): Promise<void> {
  await secrets.store(KEY_PREFIX + provider, key);
}

export async function deleteKey(secrets: vscode.SecretStorage, provider: ProviderId): Promise<void> {
  await secrets.delete(KEY_PREFIX + provider);
}

/**
 * Prompt for and store an API key for a provider chosen via quick pick.
 * Ollama needs no key, so it is offered as "no key required".
 */
export async function promptForApiKey(secrets: vscode.SecretStorage): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    Object.values(PROVIDERS).map((p) => ({ label: p.label, id: p.id })),
    { placeHolder: "Which provider's API key do you want to set?" },
  );
  if (!pick) return;

  if (pick.id === "ollama") {
    vscode.window.showInformationMessage("Ollama runs locally and needs no API key.");
    return;
  }

  const key = await vscode.window.showInputBox({
    prompt: `Enter your ${pick.label} API key`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!key) return;

  await setKey(secrets, pick.id, key.trim());
  vscode.window.showInformationMessage(`${pick.label} key saved to your OS keychain.`);
}
