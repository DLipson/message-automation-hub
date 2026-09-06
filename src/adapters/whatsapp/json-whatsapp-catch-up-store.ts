import { dirname, join } from "node:path";
import { defaultEnvFilePath } from "../../config.js";
import { AtomicJsonFile } from "../atomic/atomic-json-file.js";

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
  /** Unix seconds of the first-ever sweep; the earliest backlog a never-seen chat may be caught up from. */
  baseline?: number;
};

export class JsonWhatsAppCatchUpStore {
  private readonly file: AtomicJsonFile<CatchUpState>;

  constructor(filePath: string) {
    this.file = new AtomicJsonFile<CatchUpState>(filePath);
  }

  async load(): Promise<CatchUpState> {
    const raw = await this.file.readRaw();
    if (raw === null) {
      return { initialized: false, chats: {} };
    }
    return {
      initialized: Boolean(raw.initialized),
      chats: raw.chats ?? {},
      ...(typeof raw.baseline === "number" ? { baseline: raw.baseline } : {}),
    };
  }

  save(state: CatchUpState): Promise<void> {
    return this.file.enqueue(() => this.file.save(state));
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