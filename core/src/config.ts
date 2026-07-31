import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SecretRef, SecretStore } from "./ports/secret-store.js";

export const PROJECT_NAME = "message-automation-hub";
export const appDefaults = {
  messageHubSecretStore: "auto",
  smtpHost: "smtp.gmail.com",
  smtpPort: 465,
  smtpSecure: true,
  imapHost: "imap.gmail.com",
  imapPort: 993,
  imapSecure: true,
  emailToWhatsappSubjectPrefix: "WA:",
  emailToWhatsappPollSeconds: 30,
  transactionCategoryRequestSubjectPrefix: "TXCAT:",
  botControlPort: 8788,
  whatsappSendTimeoutMs: 90_000,
  emailMessageIdDomain: "message-automation-hub.local",
} as const;

export const SMTP_PASSWORD_SECRET: SecretRef = {
  service: PROJECT_NAME,
  account: "smtp-password",
};

export type WhatsAppForwardFilterConfig = {
  enabled: boolean;
  whitelist: string[];
  blacklist: string[];
};

export type AppConfig = {
  whatsapp: {
    phoneNumber: string;
    forwardStatuses: WhatsAppForwardFilterConfig;
    forwardGroups: WhatsAppForwardFilterConfig;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  email: {
    from: string;
    to: string;
    messageIdDomain: string;
  };
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
  };
  emailToWhatsapp: {
    enabled: boolean;
    subjectPrefix: string;
    pollIntervalMs: number;
  };
  transactionCategoryRequest: {
    enabled: boolean;
    subjectPrefix: string;
    recipientPhoneNumber: string;
  };
};

export function loadRuntimeEnv(env = process.env): void {
  const path = env.MESSAGE_HUB_ENV_FILE ?? defaultEnvFilePath();

  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

export function defaultEnvFilePath(homeDirectory = homedir()): string {
  return join(homeDirectory, "secrets", PROJECT_NAME, ".env");
}

export async function loadSmtpPassword(secretStore: SecretStore): Promise<string> {
  const password = await secretStore.get(SMTP_PASSWORD_SECRET);

  if (!password) {
    throw new Error(
      `Missing OS credential: ${SMTP_PASSWORD_SECRET.service}/${SMTP_PASSWORD_SECRET.account}`,
    );
  }

  return password;
}

export function normalizeSmtpPassword(password: string): string {
  const normalized = password.replaceAll(" ", "").trim();

  if (!normalized) {
    throw new Error("SMTP password cannot be empty");
  }

  return normalized;
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  secrets: { smtpPassword: string },
): AppConfig {
  const transactionCategoryRequestEnabled =
    readOptionalBoolean(env, "TRANSACTION_CATEGORY_REQUEST_ENABLED") ?? false;

  return {
    whatsapp: {
      phoneNumber: requireEnv(env, "WHATSAPP_PHONE_NUMBER"),
      forwardStatuses: readWhatsAppForwardFilter(
        env,
        "WHATSAPP_FORWARD_STATUSES_ENABLED",
        "WHATSAPP_FORWARD_STATUS_WHITELIST",
        "WHATSAPP_FORWARD_STATUS_BLACKLIST",
      ),
      forwardGroups: readWhatsAppForwardFilter(
        env,
        "WHATSAPP_FORWARD_GROUPS_ENABLED",
        "WHATSAPP_FORWARD_GROUP_WHITELIST",
        "WHATSAPP_FORWARD_GROUP_BLACKLIST",
      ),
    },
    smtp: {
      host: requireEnv(env, "SMTP_HOST"),
      port: readPort(env),
      secure: readBoolean(env, "SMTP_SECURE"),
      user: requireEnv(env, "SMTP_USER"),
      pass: secrets.smtpPassword,
    },
    email: {
      from: requireEnv(env, "EMAIL_FROM"),
      to: requireEnv(env, "EMAIL_TO"),
      messageIdDomain:
        optionalEnv(env, "EMAIL_MESSAGE_ID_DOMAIN") ??
        appDefaults.emailMessageIdDomain,
    },
    imap: {
      host: optionalEnv(env, "IMAP_HOST") ?? appDefaults.imapHost,
      port: readOptionalPort(env, "IMAP_PORT") ?? appDefaults.imapPort,
      secure: readOptionalBoolean(env, "IMAP_SECURE") ?? appDefaults.imapSecure,
      user: optionalEnv(env, "IMAP_USER") ?? requireEnv(env, "SMTP_USER"),
      pass: secrets.smtpPassword,
    },
    emailToWhatsapp: {
      enabled: readOptionalBoolean(env, "EMAIL_TO_WHATSAPP_ENABLED") ?? false,
      subjectPrefix:
        optionalEnv(env, "EMAIL_TO_WHATSAPP_SUBJECT_PREFIX") ??
        appDefaults.emailToWhatsappSubjectPrefix,
      pollIntervalMs:
        (readOptionalPort(env, "EMAIL_TO_WHATSAPP_POLL_SECONDS") ??
          appDefaults.emailToWhatsappPollSeconds) * 1000,
    },
    transactionCategoryRequest: {
      enabled: transactionCategoryRequestEnabled,
      subjectPrefix:
        optionalEnv(env, "TRANSACTION_CATEGORY_REQUEST_SUBJECT_PREFIX") ??
        appDefaults.transactionCategoryRequestSubjectPrefix,
      recipientPhoneNumber: readOptionalPhoneNumber(
        env,
        "TRANSACTION_CATEGORY_REQUEST_RECIPIENT_PHONE_NUMBER",
        transactionCategoryRequestEnabled,
      ),
    },
  };
}

function readWhatsAppForwardFilter(
  env: NodeJS.ProcessEnv,
  enabledKey: string,
  whitelistKey: string,
  blacklistKey: string,
): WhatsAppForwardFilterConfig {
  const whitelist = readOptionalList(env, whitelistKey);
  const blacklist = readOptionalList(env, blacklistKey);

  if (whitelist.length > 0 && blacklist.length > 0) {
    throw new Error(`${whitelistKey} and ${blacklistKey} cannot both be set`);
  }

  return {
    enabled: readOptionalBoolean(env, enabledKey) ?? false,
    whitelist,
    blacklist,
  };
}

function readOptionalList(env: NodeJS.ProcessEnv, key: string): string[] {
  return (optionalEnv(env, key) ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  return env[key]?.trim() || null;
}

function readPort(env: NodeJS.ProcessEnv): number {
  const value = Number(requireEnv(env, "SMTP_PORT"));

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("SMTP_PORT must be a positive integer");
  }

  return value;
}

function readOptionalPort(
  env: NodeJS.ProcessEnv,
  key: string,
): number | null {
  const rawValue = optionalEnv(env, key);

  if (!rawValue) {
    return null;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return value;
}

function readBoolean(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = requireEnv(env, key).toLowerCase();

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${key} must be true or false`);
}

function readOptionalBoolean(
  env: NodeJS.ProcessEnv,
  key: string,
): boolean | null {
  const value = optionalEnv(env, key)?.toLowerCase();

  if (!value) {
    return null;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${key} must be true or false`);
}

function readOptionalPhoneNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  required: boolean,
): string {
  const rawValue = required ? requireEnv(env, key) : optionalEnv(env, key);

  if (!rawValue) {
    return "";
  }

  const phoneNumber = rawValue.replace(/\D/g, "");

  if (!phoneNumber) {
    throw new Error(`${key} must contain at least one digit`);
  }

  return phoneNumber;
}


