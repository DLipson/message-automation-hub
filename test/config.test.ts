import { describe, expect, it } from "vitest";
import {
  defaultEnvFilePath,
  loadConfig,
  loadSmtpPassword,
} from "../src/config.js";
import type { SecretStore } from "../src/ports/secret-store.js";

const validEnv = {
  WHATSAPP_PHONE_NUMBER: "12025550108",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "bot@example.com",
  EMAIL_FROM: "bot@example.com",
  EMAIL_TO: "me@example.com",
};

describe("loadConfig", () => {
  it("loads required settings from environment variables", () => {
    expect(loadConfig(validEnv, { smtpPassword: "secret" })).toEqual({
      whatsapp: {
        phoneNumber: "12025550108",
      },
      smtp: {
        host: "smtp.example.com",
        port: 465,
        secure: true,
        user: "bot@example.com",
        pass: "secret",
      },
      email: {
        from: "bot@example.com",
        to: "me@example.com",
      },
    });
  });

  it("fails fast when a required setting is missing", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        SMTP_USER: "",
      }, { smtpPassword: "secret" }),
    ).toThrow("Missing required environment variable: SMTP_USER");
  });

  it("rejects invalid SMTP ports", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        SMTP_PORT: "abc",
      }, { smtpPassword: "secret" }),
    ).toThrow("SMTP_PORT must be a positive integer");
  });

  it("uses the external secrets folder as the default env file path", () => {
    expect(defaultEnvFilePath("C:\\Users\\Dovid L")).toBe(
      "C:\\Users\\Dovid L\\secrets\\message-automation-hub\\.env",
    );
  });

  it("loads the SMTP password from a secret store", async () => {
    const secretStore: SecretStore = {
      async get() {
        return "secret";
      },
      async set() {},
      async delete() {
        return true;
      },
    };

    await expect(loadSmtpPassword(secretStore)).resolves.toBe("secret");
  });

  it("fails fast when the SMTP password is missing from the secret store", async () => {
    const secretStore: SecretStore = {
      async get() {
        return null;
      },
      async set() {},
      async delete() {
        return false;
      },
    };

    await expect(loadSmtpPassword(secretStore)).rejects.toThrow(
      "Missing OS credential: message-automation-hub/smtp-password",
    );
  });
});
