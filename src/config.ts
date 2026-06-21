import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { SecretRef, SecretStore } from "./ports/secret-store.js";

export const PROJECT_NAME = "message-automation-hub";
export const SMTP_PASSWORD_SECRET: SecretRef = {
  service: PROJECT_NAME,
  account: "smtp-password",
};

export type AppConfig = {
  whatsapp: {
    phoneNumber: string;
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
  };
};

export function loadRuntimeEnv(env = process.env): void {
  const path = env.MESSAGE_HUB_ENV_FILE ?? defaultEnvFilePath();

  if (existsSync(path)) {
    loadDotenv({ path, override: false });
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

export function loadConfig(
  env: NodeJS.ProcessEnv,
  secrets: { smtpPassword: string },
): AppConfig {
  return {
    whatsapp: {
      phoneNumber: requireEnv(env, "WHATSAPP_PHONE_NUMBER"),
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
    },
  };
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function readPort(env: NodeJS.ProcessEnv): number {
  const value = Number(requireEnv(env, "SMTP_PORT"));

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("SMTP_PORT must be a positive integer");
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
