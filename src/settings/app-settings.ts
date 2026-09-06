import { loadConfig, type AppConfig } from "../config.js";
import {
  isSecretStoreMode,
  type SecretStoreMode,
} from "../adapters/secrets/secret-store-factory.js";
import { fields } from "./settings-mapping.js";

export type AppSettings = {
  whatsappPhoneNumber: string;
  messageHubSecretStore: SecretStoreMode;
  messageHubSecretFile: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  smtpUser: string;
  emailFrom: string;
  emailTo: string;
  emailMessageIdDomain: string;
  whatsappForwardStatusesEnabled: boolean;
  whatsappForwardStatusWhitelist: string;
  whatsappForwardStatusBlacklist: string;
  whatsappForwardGroupsEnabled: boolean;
  whatsappForwardGroupWhitelist: string;
  whatsappForwardGroupBlacklist: string;
  emailToWhatsappEnabled: boolean;
  emailToWhatsappSubjectPrefix: string;
  emailToWhatsappPollSeconds: string;
  transactionCategoryRequestEnabled: boolean;
  transactionCategoryRequestSubjectPrefix: string;
  transactionCategoryRequestRecipientPhoneNumber: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  imapUser: string;
};

export const emptyAppSettings: AppSettings = Object.fromEntries(
  fields.map(f => [f.key, f.defaultValue]),
) as unknown as AppSettings;

export function appSettingsToEnv(settings: AppSettings): Record<string, string> {
  const env: Record<string, string> = {};
  for (const field of fields) {
    env[field.env] = String(settings[field.key as keyof AppSettings]);
  }
  return env;
}

export function envToAppSettings(
  env: Record<string, string | undefined>,
): AppSettings {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = env[field.env];
    switch (field.parser) {
      case "string":
        result[field.key] = raw ?? field.defaultValue;
        break;
      case "boolean":
        result[field.key] = readBoolean(raw, field.env, field.defaultValue as boolean);
        break;
      case "secretStoreMode":
        result[field.key] = readSecretStoreMode(raw, field.defaultValue as string);
        break;
    }
  }
  return result as AppSettings;
}

export function validateAppSettings(settings: AppSettings): void {
  if (!isSecretStoreMode(settings.messageHubSecretStore)) {
    throw new Error(
      "MESSAGE_HUB_SECRET_STORE must be auto, windows-credential, or file",
    );
  }

  loadConfig(appSettingsToEnv(settings), { smtpPassword: "validation-only" });
}

export function settingsToEmailConfig(
  settings: AppSettings,
  smtpPassword: string,
): AppConfig {
  return loadConfig(appSettingsToEnv(settings), { smtpPassword });
}

function readSecretStoreMode(value: string | undefined, defaultValue: string): SecretStoreMode {
  const mode = value ?? defaultValue;

  if (!isSecretStoreMode(mode)) {
    throw new Error(
      "MESSAGE_HUB_SECRET_STORE must be auto, windows-credential, or file",
    );
  }

  return mode;
}

function readBoolean(
  value: string | undefined,
  key: string,
  defaultValue: boolean,
): boolean {
  const normalized = value?.toLowerCase();

  if (!normalized) {
    return defaultValue;
  }

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error(`${key} must be true or false`);
}
