import { SMTP_PASSWORD_SECRET } from "../config.js";
import type { SecretStore } from "../ports/secret-store.js";

export class SecretStatus {
  constructor(private readonly secretStore: SecretStore) {}

  async hasSmtpPassword(): Promise<boolean> {
    return Boolean(await this.secretStore.get(SMTP_PASSWORD_SECRET));
  }

  async setSmtpPassword(password: string): Promise<void> {
    const trimmed = password.trim();

    if (!trimmed) {
      throw new Error("SMTP password cannot be empty");
    }

    await this.secretStore.set(SMTP_PASSWORD_SECRET, trimmed);
  }

  async deleteSmtpPassword(): Promise<boolean> {
    return this.secretStore.delete(SMTP_PASSWORD_SECRET);
  }
}
