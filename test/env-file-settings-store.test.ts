import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { appDefaults } from "../src/config.js";
import { EnvFileSettingsStore } from "../src/settings/env-file-settings-store.js";
import {
  emptyAppSettings,
  envToAppSettings,
  validateAppSettings,
} from "../src/settings/app-settings.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(dir => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

describe("EnvFileSettingsStore", () => {
  it("returns default settings when the env file does not exist", async () => {
    const store = new EnvFileSettingsStore(await tempPath("missing.env"));

    await expect(store.read()).resolves.toMatchObject({
      smtpHost: appDefaults.smtpHost,
      smtpPort: String(appDefaults.smtpPort),
      smtpSecure: appDefaults.smtpSecure,
      emailMessageIdDomain: appDefaults.emailMessageIdDomain,
      transactionCategoryRequestEnabled: false,
      transactionCategoryRequestSubjectPrefix:
        appDefaults.transactionCategoryRequestSubjectPrefix,
      transactionCategoryRequestRecipientPhoneNumber: "",
    });
  });

  it("writes and reads non-secret settings", async () => {
    const filePath = await tempPath("settings.env");
    const store = new EnvFileSettingsStore(filePath);

    await store.write({
      whatsappPhoneNumber: "12025550108",
      messageHubSecretStore: "file",
      messageHubSecretFile: "/home/opc/secrets/message-automation-hub/secrets.json",
      smtpHost: "smtp.gmail.com",
      smtpPort: "465",
      smtpSecure: true,
      smtpUser: "bot@example.com",
      emailFrom: "bot@example.com",
      emailTo: "me@example.com",
      emailMessageIdDomain: "mail.example.test",
      emailToWhatsappEnabled: true,
      emailToWhatsappSubjectPrefix: "WA:",
      emailToWhatsappPollSeconds: "30",
      transactionCategoryRequestEnabled: true,
      transactionCategoryRequestSubjectPrefix: "TXCAT:",
      transactionCategoryRequestRecipientPhoneNumber: "972501234567",
      imapHost: "imap.gmail.com",
      imapPort: "993",
      imapSecure: true,
      imapUser: "bot@example.com",
    });

    await expect(store.read()).resolves.toEqual({
      whatsappPhoneNumber: "12025550108",
      messageHubSecretStore: "file",
      messageHubSecretFile: "/home/opc/secrets/message-automation-hub/secrets.json",
      smtpHost: "smtp.gmail.com",
      smtpPort: "465",
      smtpSecure: true,
      smtpUser: "bot@example.com",
      emailFrom: "bot@example.com",
      emailTo: "me@example.com",
      emailMessageIdDomain: "mail.example.test",
      emailToWhatsappEnabled: true,
      emailToWhatsappSubjectPrefix: "WA:",
      emailToWhatsappPollSeconds: "30",
      transactionCategoryRequestEnabled: true,
      transactionCategoryRequestSubjectPrefix: "TXCAT:",
      transactionCategoryRequestRecipientPhoneNumber: "972501234567",
      imapHost: "imap.gmail.com",
      imapPort: "993",
      imapSecure: true,
      imapUser: "bot@example.com",
    });

    await expect(readFile(filePath, "utf8")).resolves.not.toContain("PASS");
  });

  it("rejects invalid env booleans", () => {
    expect(() => envToAppSettings({ SMTP_SECURE: "yes" })).toThrow(
      "SMTP_SECURE must be true or false",
    );
  });

  it("validates settings before they are persisted by the server", () => {
    expect(() => validateAppSettings({
      ...emptyAppSettings,
      smtpPort: "abc",
    })).toThrow("SMTP_PORT must be a positive integer");

    expect(() => validateAppSettings({
      ...emptyAppSettings,
      imapPort: "abc",
    })).toThrow("IMAP_PORT must be a positive integer");

    expect(() => validateAppSettings({
      ...emptyAppSettings,
      emailToWhatsappPollSeconds: "abc",
    })).toThrow("EMAIL_TO_WHATSAPP_POLL_SECONDS must be a positive integer");

    expect(() => validateAppSettings({
      ...emptyAppSettings,
      messageHubSecretStore: "bogus",
    } as typeof emptyAppSettings)).toThrow(
      "MESSAGE_HUB_SECRET_STORE must be auto, windows-credential, or file",
    );
  });
});

async function tempPath(fileName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "message-automation-hub-"));
  tempDirs.push(dir);
  return join(dir, fileName);
}
