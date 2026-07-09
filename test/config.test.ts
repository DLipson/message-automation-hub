import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appDefaults,
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
        forwardStatuses: {
          enabled: false,
          whitelist: [],
          blacklist: [],
        },
        forwardGroups: {
          enabled: false,
          whitelist: [],
          blacklist: [],
        },
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
        messageIdDomain: appDefaults.emailMessageIdDomain,
      },
      imap: {
        host: appDefaults.imapHost,
        port: appDefaults.imapPort,
        secure: appDefaults.imapSecure,
        user: "bot@example.com",
        pass: "secret",
      },
      emailToWhatsapp: {
        enabled: false,
        subjectPrefix: appDefaults.emailToWhatsappSubjectPrefix,
        pollIntervalMs: appDefaults.emailToWhatsappPollSeconds * 1000,
      },
      transactionCategoryRequest: {
        enabled: false,
        subjectPrefix: appDefaults.transactionCategoryRequestSubjectPrefix,
        recipientPhoneNumber: "",
      },
    });
  });

  it("loads optional email automation settings", () => {
    expect(
      loadConfig(
        {
          ...validEnv,
          EMAIL_MESSAGE_ID_DOMAIN: "mail.example.test",
          EMAIL_TO_WHATSAPP_ENABLED: "true",
          EMAIL_TO_WHATSAPP_SUBJECT_PREFIX: "SEND:",
          EMAIL_TO_WHATSAPP_POLL_SECONDS: "10",
          IMAP_HOST: "imap.example.com",
          IMAP_PORT: "993",
          IMAP_SECURE: "true",
          IMAP_USER: "reader@example.com",
          TRANSACTION_CATEGORY_REQUEST_ENABLED: "true",
          TRANSACTION_CATEGORY_REQUEST_SUBJECT_PREFIX: "CAT:",
          TRANSACTION_CATEGORY_REQUEST_RECIPIENT_PHONE_NUMBER:
            "+972 50-123-4567",
          WHATSAPP_FORWARD_STATUSES_ENABLED: "true",
          WHATSAPP_FORWARD_STATUS_WHITELIST: "12025550108@c.us, 441234567890@c.us",
          WHATSAPP_FORWARD_GROUPS_ENABLED: "true",
          WHATSAPP_FORWARD_GROUP_BLACKLIST: "111@g.us, 222@g.us",
        },
        { smtpPassword: "secret" },
      ),
    ).toMatchObject({
      whatsapp: {
        forwardStatuses: {
          enabled: true,
          whitelist: ["12025550108@c.us", "441234567890@c.us"],
          blacklist: [],
        },
        forwardGroups: {
          enabled: true,
          whitelist: [],
          blacklist: ["111@g.us", "222@g.us"],
        },
      },
      email: {
        messageIdDomain: "mail.example.test",
      },
      imap: {
        host: "imap.example.com",
        port: 993,
        secure: true,
        user: "reader@example.com",
        pass: "secret",
      },
      emailToWhatsapp: {
        enabled: true,
        subjectPrefix: "SEND:",
        pollIntervalMs: 10000,
      },
      transactionCategoryRequest: {
        enabled: true,
        subjectPrefix: "CAT:",
        recipientPhoneNumber: "972501234567",
      },
    });
  });

  it("rejects both whitelist and blacklist for one WhatsApp forward type", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        WHATSAPP_FORWARD_STATUS_WHITELIST: "12025550108@c.us",
        WHATSAPP_FORWARD_STATUS_BLACKLIST: "441234567890@c.us",
      }, { smtpPassword: "secret" }),
    ).toThrow("WHATSAPP_FORWARD_STATUS_WHITELIST and WHATSAPP_FORWARD_STATUS_BLACKLIST cannot both be set");
  });

  it("requires a transaction category recipient when the automation is enabled", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        TRANSACTION_CATEGORY_REQUEST_ENABLED: "true",
      }, { smtpPassword: "secret" }),
    ).toThrow(
      "Missing required environment variable: TRANSACTION_CATEGORY_REQUEST_RECIPIENT_PHONE_NUMBER",
    );
  });

  it("fails fast when a required setting is missing", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        SMTP_USER: "",
      }, { smtpPassword: "secret" }),
    ).toThrow("Missing required environment variable: SMTP_USER");
  });

  it("rejects invalid numeric and boolean settings", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        SMTP_PORT: "abc",
      }, { smtpPassword: "secret" }),
    ).toThrow("SMTP_PORT must be a positive integer");

    expect(() =>
      loadConfig({
        ...validEnv,
        IMAP_PORT: "abc",
      }, { smtpPassword: "secret" }),
    ).toThrow("IMAP_PORT must be a positive integer");

    expect(() =>
      loadConfig({
        ...validEnv,
        EMAIL_TO_WHATSAPP_POLL_SECONDS: "abc",
      }, { smtpPassword: "secret" }),
    ).toThrow("EMAIL_TO_WHATSAPP_POLL_SECONDS must be a positive integer");

    expect(() =>
      loadConfig({
        ...validEnv,
        SMTP_SECURE: "yes",
      }, { smtpPassword: "secret" }),
    ).toThrow("SMTP_SECURE must be true or false");
  });

  it("uses the external secrets folder as the default env file path", () => {
    const home = join("home", "example-user");

    expect(defaultEnvFilePath(home)).toBe(
      join(home, "secrets", "message-automation-hub", ".env"),
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

