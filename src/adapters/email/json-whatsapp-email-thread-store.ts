import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { appDefaults, defaultEnvFilePath } from "../../config.js";
import type {
  WhatsAppEmailThread,
  WhatsAppEmailThreadStore,
} from "../../use-cases/whatsapp-email-thread-store.js";
import { AtomicJsonFile } from "../atomic/atomic-json-file.js";

export type JsonWhatsAppEmailThreadStoreOptions = {
  messageIdDomain?: string;
};

export class JsonWhatsAppEmailThreadStore implements WhatsAppEmailThreadStore {
  private readonly messageIdDomain: string;
  private readonly file: AtomicJsonFile<WhatsAppEmailThread[]>;

  constructor(
    filePath: string,
    options: JsonWhatsAppEmailThreadStoreOptions = {},
  ) {
    this.messageIdDomain = options.messageIdDomain ?? appDefaults.emailMessageIdDomain;
    this.file = new AtomicJsonFile<WhatsAppEmailThread[]>(filePath);
  }

  async getOrCreate(
    chatId: string,
    contactLabel: string,
  ): Promise<WhatsAppEmailThread> {
    return await this.file.enqueue(async () => {
      const threads = await this.readThreads();
      const existing = threads.find(thread => thread.chatId === chatId);

      if (existing) {
        return existing;
      }

      const token = randomBytes(6).toString("base64url");
      const thread = {
        token,
        chatId,
        subject: `WhatsApp message from ${cleanSubject(contactLabel)} [wa:${token}]`,
        rootMessageId: `<wa.${token}@${this.messageIdDomain}>`,
      };

      await this.file.save([...threads, thread]);
      return thread;
    });
  }

  async getActive(chatId: string): Promise<WhatsAppEmailThread | undefined> {
    const threads = await this.readThreads();
    // ponytail: backward compat — threads without `active` field are treated as active
    return threads.find(t => t.chatId === chatId && t.active !== false);
  }

  async createNew(
    chatId: string,
    contactLabel: string,
  ): Promise<WhatsAppEmailThread> {
    return await this.file.enqueue(async () => {
      const threads = await this.readThreads();
      // Demote any existing active thread for this chatId
      const updated = threads.map(t =>
        t.chatId === chatId && t.active !== false
          ? { ...t, active: false as const }
          : t,
      );

      const token = randomBytes(6).toString("base64url");
      const thread: WhatsAppEmailThread = {
        token,
        chatId,
        subject: `WhatsApp message from ${cleanSubject(contactLabel)} [wa:${token}]`,
        rootMessageId: `<wa.${token}@${this.messageIdDomain}>`,
        active: true,
      };

      await this.file.save([...updated, thread]);
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

  private async readThreads(): Promise<WhatsAppEmailThread[]> {
    return (await this.file.readRaw()) ?? [];
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
