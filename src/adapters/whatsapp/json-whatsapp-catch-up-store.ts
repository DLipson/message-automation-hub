import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultEnvFilePath } from "../../config.js";
import { isFileMissing } from "../../errors.js";

/**
 * Persisted per-chat watermark for the catch-up sweep.
 *
 * `chats[chatId]` is the Unix timestamp (seconds) of the newest WhatsApp message
 * already forwarded for that chat. `initialized` is set on the first-ever run so
 * the sweep never forwards the account's pre-existing history.
 */
export type CatchUpState = {
  initialized: boolean;
  chats: Record<string, number>;
};

export class JsonWhatsAppCatchUpStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<CatchUpState> {
    try {
      const raw = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<CatchUpState>;
      return { initialized: Boolean(raw.initialized), chats: raw.chats ?? {} };
    } catch (error) {
      if (isFileMissing(error)) {
        return { initialized: false, chats: {} };
      }
      throw error;
    }
  }

  save(state: CatchUpState): Promise<void> {
    return this.enqueue(() => this.atomicWrite(state));
  }

  private async atomicWrite(state: CatchUpState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tempPath, this.filePath);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

export function defaultWhatsAppCatchUpStorePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.WHATSAPP_CATCH_UP_STORE_FILE ?? join(
    dirname(env.MESSAGE_HUB_ENV_FILE ?? defaultEnvFilePath()),
    "whatsapp-catch-up.json",
  );
}