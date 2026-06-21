import { describe, expect, it } from "vitest";
import type { SecretRef, SecretStore } from "../src/ports/secret-store.js";
import { SecretStatus } from "../src/settings/secret-status.js";

class FakeSecretStore implements SecretStore {
  private value: string | null = null;

  async get(_ref: SecretRef): Promise<string | null> {
    return this.value;
  }

  async set(_ref: SecretRef, value: string): Promise<void> {
    this.value = value;
  }

  async delete(_ref: SecretRef): Promise<boolean> {
    const existed = this.value !== null;
    this.value = null;
    return existed;
  }
}

describe("SecretStatus", () => {
  it("reports and updates SMTP password status without exposing the value", async () => {
    const store = new FakeSecretStore();
    const status = new SecretStatus(store);

    await expect(status.hasSmtpPassword()).resolves.toBe(false);

    await status.setSmtpPassword("secret");

    await expect(status.hasSmtpPassword()).resolves.toBe(true);

    await status.deleteSmtpPassword();

    await expect(status.hasSmtpPassword()).resolves.toBe(false);
  });

  it("rejects empty SMTP passwords", async () => {
    const status = new SecretStatus(new FakeSecretStore());

    await expect(status.setSmtpPassword(" ")).rejects.toThrow(
      "SMTP password cannot be empty",
    );
  });

  it("removes spaces from pasted app passwords before saving", async () => {
    const store = new FakeSecretStore();
    const status = new SecretStatus(store);

    await status.setSmtpPassword("abcd efgh ijkl mnop");

    await expect(store.get({ service: "any", account: "any" })).resolves.toBe(
      "abcdefghijklmnop",
    );
  });
});
