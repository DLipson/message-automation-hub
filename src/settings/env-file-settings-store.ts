import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "dotenv";
import {
  emptyAppSettings,
  envToAppSettings,
  type AppSettings,
} from "./app-settings.js";

export class EnvFileSettingsStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<AppSettings> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return envToAppSettings(parse(content));
    } catch (error) {
      if (isFileMissing(error)) {
        return emptyAppSettings;
      }

      throw error;
    }
  }

  async write(settings: AppSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, this.serialize(settings), "utf8");
    await rename(tempPath, this.filePath);
  }

  private serialize(settings: AppSettings): string {
    return [
      `WHATSAPP_PHONE_NUMBER=${formatEnvValue(settings.whatsappPhoneNumber)}`,
      `MESSAGE_HUB_SECRET_STORE=${formatEnvValue(settings.messageHubSecretStore)}`,
      `MESSAGE_HUB_SECRET_FILE=${formatEnvValue(settings.messageHubSecretFile)}`,
      "",
      `SMTP_HOST=${formatEnvValue(settings.smtpHost)}`,
      `SMTP_PORT=${formatEnvValue(settings.smtpPort)}`,
      `SMTP_SECURE=${formatEnvValue(String(settings.smtpSecure))}`,
      `SMTP_USER=${formatEnvValue(settings.smtpUser)}`,
      "",
      `EMAIL_FROM=${formatEnvValue(settings.emailFrom)}`,
      `EMAIL_TO=${formatEnvValue(settings.emailTo)}`,
      "",
      `EMAIL_TO_WHATSAPP_ENABLED=${formatEnvValue(String(settings.emailToWhatsappEnabled))}`,
      `EMAIL_TO_WHATSAPP_SUBJECT_PREFIX=${formatEnvValue(settings.emailToWhatsappSubjectPrefix)}`,
      `EMAIL_TO_WHATSAPP_POLL_SECONDS=${formatEnvValue(settings.emailToWhatsappPollSeconds)}`,
      `IMAP_HOST=${formatEnvValue(settings.imapHost)}`,
      `IMAP_PORT=${formatEnvValue(settings.imapPort)}`,
      `IMAP_SECURE=${formatEnvValue(String(settings.imapSecure))}`,
      `IMAP_USER=${formatEnvValue(settings.imapUser)}`,
      "",
    ].join("\n");
  }
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9@._:+/-]*$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function isFileMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
