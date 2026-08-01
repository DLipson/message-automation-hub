import keytar from "keytar";
import type { SecretRef, SecretStore } from "../../ports/secret-store.js";

export class OsCredentialSecretStore implements SecretStore {
  async get(ref: SecretRef): Promise<string | null> {
    return keytar.getPassword(ref.service, ref.account);
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    await keytar.setPassword(ref.service, ref.account, value);
  }

  async delete(ref: SecretRef): Promise<boolean> {
    return keytar.deletePassword(ref.service, ref.account);
  }
}
