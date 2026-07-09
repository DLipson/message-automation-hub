import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appDefaults, defaultEnvFilePath } from "../../config.js";
import type {
  WhatsAppEmailThread,
  WhatsAppEmailThreadStore,
} from "../../use-cases/whatsapp-email-thread-store.js";

export type JsonWhatsAppEmailThreadStoreOptions = {
  messageIdDomain?: string;
};

export class JsonWhatsAppEmailThreadStore implements WhatsAppEmailThreadStore {
  private readonly messageIdDomain: string;
  private writeQueue = Promise.resolve();

  constructor(
    private readonly filePath: string,
    options: JsonWhatsAppEmailThreadStoreOptions = {},
  ) {
    this.messageIdDomain = options.messageIdDomain ?? appDefaults.emailMessageIdDomain;
  }

  async getOrCreate(
    chatId: string,
    displayName: string,
  ): Promise<WhatsAppEmailThread> {
    return await this.enqueue(async () => {
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
        rootMessageId: `<wa.${token}@${this.messageIdDomain}>`,
      };

      await this.writeThreads([...threads, thread]);
      return thread;
    });
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

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return await result;
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
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(threads, null, 2)}\n`);
    await rename(tempPath, this.filePath);
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
