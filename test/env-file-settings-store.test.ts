import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { EnvFileSettingsStore } from "../src/settings/env-file-settings-store.js";

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
      smtpHost: "smtp.gmail.com",
      smtpPort: "465",
      smtpSecure: true,
    });
  });

  it("writes and reads non-secret settings", async () => {
    const filePath = await tempPath("settings.env");
    const store = new EnvFileSettingsStore(filePath);

    await store.write({
      whatsappPhoneNumber: "12025550108",
      smtpHost: "smtp.gmail.com",
      smtpPort: "465",
      smtpSecure: true,
      smtpUser: "bot@example.com",
      emailFrom: "bot@example.com",
      emailTo: "me@example.com",
      emailToWhatsappEnabled: true,
      emailToWhatsappSubjectPrefix: "WA:",
      emailToWhatsappPollSeconds: "30",
      imapHost: "imap.gmail.com",
      imapPort: "993",
      imapSecure: true,
      imapUser: "bot@example.com",
    });

    await expect(store.read()).resolves.toEqual({
      whatsappPhoneNumber: "12025550108",
      smtpHost: "smtp.gmail.com",
      smtpPort: "465",
      smtpSecure: true,
      smtpUser: "bot@example.com",
      emailFrom: "bot@example.com",
      emailTo: "me@example.com",
      emailToWhatsappEnabled: true,
      emailToWhatsappSubjectPrefix: "WA:",
      emailToWhatsappPollSeconds: "30",
      imapHost: "imap.gmail.com",
      imapPort: "993",
      imapSecure: true,
      imapUser: "bot@example.com",
    });

    await expect(readFile(filePath, "utf8")).resolves.not.toContain("PASS");
  });
});

async function tempPath(fileName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "message-automation-hub-"));
  tempDirs.push(dir);
  return join(dir, fileName);
}
