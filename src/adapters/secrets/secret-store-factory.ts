import { homedir, platform } from "node:os";
import { join } from "node:path";
import { PROJECT_NAME } from "../../config.js";
import type { SecretStore } from "../../ports/secret-store.js";
import { FileSecretStore } from "./file-secret-store.js";

export type SecretStoreKind = "windows-credential" | "file";
export type SecretStoreMode = SecretStoreKind | "auto";

export type SecretStoreSelection = {
  kind: SecretStoreKind;
  filePath?: string;
};

export function defaultSecretFilePath(homeDirectory = homedir()): string {
  return join(homeDirectory, "secrets", PROJECT_NAME, "secrets.json");
}

export function selectSecretStore(
  env: NodeJS.ProcessEnv = process.env,
  currentPlatform = platform(),
): SecretStoreSelection {
  const mode = readSecretStoreMode(env.MESSAGE_HUB_SECRET_STORE);

  if (mode === "file") {
    return {
      kind: "file",
      filePath: secretFilePath(env),
    };
  }

  if (mode === "windows-credential") {
    return { kind: "windows-credential" };
  }

  if (currentPlatform === "win32") {
    return { kind: "windows-credential" };
  }

  return {
    kind: "file",
    filePath: secretFilePath(env),
  };
}

export async function createSecretStore(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SecretStore> {
  const selection = selectSecretStore(env);

  if (selection.kind === "file") {
    return new FileSecretStore(selection.filePath ?? defaultSecretFilePath());
  }

  const { OsCredentialSecretStore } = await import(
    "./os-credential-secret-store.js"
  );
  return new OsCredentialSecretStore();
}

function readSecretStoreMode(value: string | undefined): SecretStoreMode {
  const mode = value?.trim();

  if (!mode || mode === "auto") {
    return "auto";
  }

  if (mode === "windows-credential" || mode === "file") {
    return mode;
  }

  throw new Error(
    "MESSAGE_HUB_SECRET_STORE must be auto, windows-credential, or file",
  );
}

function secretFilePath(env: NodeJS.ProcessEnv): string {
  return env.MESSAGE_HUB_SECRET_FILE?.trim() || defaultSecretFilePath();
}
