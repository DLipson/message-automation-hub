import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultEnvFilePath } from "../../config.js";
import type {
  WhatsAppEmailThread,
  WhatsAppEmailThreadStore,
} from "../../use-cases/whatsapp-email-thread-store.js";

export class JsonWhatsAppEmailThreadStore implements WhatsAppEmailThreadStore {
  constructor(private readonly filePath: string) {}

  async getOrCreate(
    chatId: string,
    displayName: string,
  ): Promise<WhatsAppEmailThread> {
    const threads = await this.readThreads();
    const existing = threads.find(thread => thread.chatId === chatId);

    if (existing) {
      return existing;
    }

    const token = randomBytes(6).toString("base64url");
    const thread = {
      token,
      chatId,
      subject: `WhatsApp: ${cleanSubject(displayName)} [wa:${token}]`,
      rootMessageId: `<wa.${token}@message-automation-hub.local>`,
    };

    await this.writeThreads([...threads, thread]);
    return thread;
  }

  async findByToken(token: string): Promise<WhatsAppEmailThread | null> {
    return (await this.readThreads()).find(thread => thread.token === token) ?? null;
  }

  async findByMessageId(messageId: string): Promise<WhatsAppEmailThread | null> {
    return (
      (await this.readThreads()).find(
        thread => normalizeMessageId(thread.rootMessageId) === normalizeMessageId(messageId),
      ) ?? null
    );
  }

  private async readThreads(): Promise<WhatsAppEmailThread[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as WhatsAppEmailThread[];
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private async writeThreads(threads: WhatsAppEmailThread[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(threads, null, 2)}\n`);
  }
}

export function defaultWhatsAppEmailThreadStorePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.EMAIL_THREAD_STORE_FILE ?? join(
    dirname(env.MESSAGE_HUB_ENV_FILE ?? defaultEnvFilePath()),
    "whatsapp-email-threads.json",
  );
}

function cleanSubject(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim() || "Unknown";
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, "");
}
