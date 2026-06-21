import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SecretRef, SecretStore } from "../../ports/secret-store.js";

type SecretFile = Record<string, string>;

export class FileSecretStore implements SecretStore {
  constructor(private readonly filePath: string) {}

  async get(ref: SecretRef): Promise<string | null> {
    const secrets = await this.readSecrets();
    return secrets[secretKey(ref)] ?? null;
  }

  async set(ref: SecretRef, value: string): Promise<void> {
    const secrets = await this.readSecrets();
    secrets[secretKey(ref)] = value;
    await this.writeSecrets(secrets);
  }

  async delete(ref: SecretRef): Promise<boolean> {
    const secrets = await this.readSecrets();
    const key = secretKey(ref);

    if (!(key in secrets)) {
      return false;
    }

    delete secrets[key];
    await this.writeSecrets(secrets);
    return true;
  }

  private async readSecrets(): Promise<SecretFile> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as SecretFile;
    } catch (error) {
      if (isFileMissing(error)) {
        return {};
      }

      throw error;
    }
  }

  private async writeSecrets(secrets: SecretFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
    await chmod(tempPath, 0o600);
    await rename(tempPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}

function secretKey(ref: SecretRef): string {
  return `${ref.service}/${ref.account}`;
}

function isFileMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
