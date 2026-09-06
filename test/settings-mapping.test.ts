import { describe, expect, it } from "vitest";
import { fields } from "../src/settings/settings-mapping.js";
import {
  emptyAppSettings,
  appSettingsToEnv,
  envToAppSettings,
  type AppSettings,
} from "../src/settings/app-settings.js";

const validSettings: AppSettings = {
  whatsappPhoneNumber: "12025550108",
  messageHubSecretStore: "file",
  messageHubSecretFile: "/home/user/secrets.json",
  smtpHost: "smtp.example.com",
  smtpPort: "587",
  smtpSecure: false,
  smtpUser: "bot@example.com",
  emailFrom: "bot@example.com",
  emailTo: "me@example.com",
  emailMessageIdDomain: "example.com",
  whatsappForwardStatusesEnabled: true,
  whatsappForwardStatusWhitelist: "12025550108@c.us",
  whatsappForwardStatusBlacklist: "",
  whatsappForwardGroupsEnabled: true,
  whatsappForwardGroupWhitelist: "",
  whatsappForwardGroupBlacklist: "111@g.us",
  emailToWhatsappEnabled: true,
  emailToWhatsappSubjectPrefix: "WA:",
  emailToWhatsappPollSeconds: "30",
  transactionCategoryRequestEnabled: true,
  transactionCategoryRequestSubjectPrefix: "TXCAT:",
  transactionCategoryRequestRecipientPhoneNumber: "972501234567",
  imapHost: "imap.example.com",
  imapPort: "993",
  imapSecure: true,
  imapUser: "imap-user@example.com",
};

describe("settings-mapping schema", () => {
  it("has exactly 26 field definitions", () => {
    expect(fields).toHaveLength(26);
  });

  it("covers all AppSettings keys", () => {
    const schemaKeys = fields.map(f => f.key).sort();
    const typeKeys = Object.keys(emptyAppSettings).sort();
    expect(schemaKeys).toEqual(typeKeys);
  });
});

describe("round-trip: envToAppSettings(appSettingsToEnv(s)) === s", () => {
  for (const field of fields) {
    it(`${field.key} (${field.env})`, () => {
      const env = appSettingsToEnv(validSettings);
      const result = envToAppSettings(env);
      expect(result[field.key as keyof AppSettings]).toEqual(
        validSettings[field.key as keyof AppSettings],
      );
    });
  }
});

describe("appSettingsToEnv key ordering", () => {
  it("outputs keys in schema order", () => {
    const env = appSettingsToEnv(emptyAppSettings);
    const keys = Object.keys(env);
    expect(keys).toEqual(fields.map(f => f.env));
  });
});

describe("emptyAppSettings derived from schema", () => {
  for (const field of fields) {
    it(`${field.key} default is ${JSON.stringify(field.defaultValue)}`, () => {
      expect(emptyAppSettings[field.key as keyof AppSettings]).toEqual(
        field.defaultValue,
      );
    });
  }
});

describe("error messages", () => {
  it("throws exact boolean error", () => {
    expect(() => envToAppSettings({ SMTP_SECURE: "yes" })).toThrow(
      "SMTP_SECURE must be true or false",
    );
  });

  it("throws exact secret store mode error", () => {
    expect(() =>
      envToAppSettings({ MESSAGE_HUB_SECRET_STORE: "bogus" }),
    ).toThrow(
      "MESSAGE_HUB_SECRET_STORE must be auto, windows-credential, or file",
    );
  });
});

describe("boolean falsy fallback", () => {
  it("empty string falls back to default", () => {
    const result = envToAppSettings({ SMTP_SECURE: "" });
    expect(result.smtpSecure).toBe(emptyAppSettings.smtpSecure);
  });

  it("undefined falls back to default", () => {
    const result = envToAppSettings({});
    expect(result.smtpSecure).toBe(emptyAppSettings.smtpSecure);
  });

  it("TRUE (uppercase) is accepted", () => {
    const result = envToAppSettings({ SMTP_SECURE: "TRUE" });
    expect(result.smtpSecure).toBe(true);
  });
});

describe("string empty-string passthrough", () => {
  it("empty env value does not replace with default", () => {
    const result = envToAppSettings({ WHATSAPP_PHONE_NUMBER: "" });
    expect(result.whatsappPhoneNumber).toBe("");
  });

  it("undefined env value falls back to default", () => {
    const result = envToAppSettings({});
    expect(result.whatsappPhoneNumber).toBe("");
  });
});
