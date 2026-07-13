import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { InboundEmail } from "../src/domain/email.js";
import type { ContactRef, InboundMessage } from "../src/domain/message.js";
import type { EmailInbox, EmailStatusMarker } from "../src/ports/email-inbox.js";
import type { EmailMessage, EmailSender } from "../src/ports/email-sender.js";
import type { InboundChannel, InboundMessageHandler } from "../src/ports/inbound-channel.js";
import type { AppLogger } from "../src/ports/app-logger.js";
import type {
  WhatsAppChatMessage,
  WhatsAppChatSender,
  WhatsAppDirectImage,
  WhatsAppDirectMessage,
  WhatsAppSender,
} from "../src/ports/whatsapp-sender.js";
import { createPluginContext, registerPlugins } from "../src/core/plugin-runtime.js";
import { capabilities } from "../src/plugins/capabilities.js";
import { createEmailCommandToWhatsAppPlugin } from "../src/plugins/workflows/email-command-to-whatsapp.js";
import { createWhatsAppEmailBridgePlugin } from "../src/plugins/workflows/whatsapp-email-bridge.js";
import type { EmailAutomationHandler } from "../src/use-cases/process-email-automations.js";
import type {
  WhatsAppEmailThread,
  WhatsAppEmailThreadStore,
} from "../src/use-cases/whatsapp-email-thread-store.js";

class FakeInboundChannel implements InboundChannel {
  readonly handlers: InboundMessageHandler[] = [];

  onMessage(handler: InboundMessageHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {}
}

class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

class FakeWhatsAppChatSender implements WhatsAppChatSender {
  readonly sent: WhatsAppChatMessage[] = [];

  async sendChatMessage(message: WhatsAppChatMessage): Promise<void> {
    this.sent.push(message);
  }
}

class FakeWhatsAppSender implements WhatsAppSender {
  readonly sent: WhatsAppDirectMessage[] = [];
  readonly sentImages: WhatsAppDirectImage[] = [];

  async sendMessage(message: WhatsAppDirectMessage): Promise<void> {
    this.sent.push(message);
  }

  async sendImage(message: WhatsAppDirectImage): Promise<void> {
    this.sentImages.push(message);
  }
}

class FakeCommandInbox implements EmailInbox, EmailStatusMarker {
  readonly labels: string[][] = [];

  async fetchUnread(): Promise<InboundEmail[]> {
    return [];
  }

  async markProcessed(): Promise<void> {}
  async markSent(): Promise<void> {}
  async markFailed(): Promise<void> {}

  async ensureLabels(labels: string[]): Promise<void> {
    this.labels.push(labels);
  }
}

class FakeThreadStore implements WhatsAppEmailThreadStore {
  readonly thread: WhatsAppEmailThread = {
    token: "thread-token",
    chatId: "chat-1",
    subject: "WhatsApp thread [wa:thread-token]",
    rootMessageId: "<wa.thread-token@message-automation-hub.local>",
  };

  async getOrCreate(): Promise<WhatsAppEmailThread> {
    return this.thread;
  }

  async findByToken(token: string): Promise<WhatsAppEmailThread | null> {
    return token === this.thread.token ? this.thread : null;
  }

  async findByMessageId(messageId: string): Promise<WhatsAppEmailThread | null> {
    return messageId === this.thread.rootMessageId ? this.thread : null;
  }
}

describe("bundled plugins", () => {
  it("registers the WhatsApp email bridge as one workflow with inbound and reply legs", async () => {
    const inbound = new FakeInboundChannel();
    const emailSender = new FakeEmailSender();
    const handlers: EmailAutomationHandler[] = [];
    const ctx = createPluginContext();
    ctx.provide(capabilities.appLogger, silentLogger);
    ctx.provide(capabilities.emailSender, emailSender);
    ctx.provide(capabilities.emailInbox, fakeInbox);
    ctx.provide(capabilities.whatsappInbound, inbound);
    ctx.provide(capabilities.whatsappChatSender, new FakeWhatsAppChatSender());
    ctx.provide(capabilities.threadStore, new FakeThreadStore());
    ctx.provide(capabilities.emailAutomationHandlers, handlers);

    await registerPlugins([createWhatsAppEmailBridgePlugin(config())], ctx);

    expect(inbound.handlers).toHaveLength(1);
    expect(handlers).toHaveLength(1);

    await inbound.handlers[0]?.(whatsappMessage());

    expect(emailSender.sent[0]?.subject).toBe("WhatsApp thread [wa:thread-token]");
  });

  it("keeps the bridge inbound leg when email-to-WhatsApp polling is disabled", async () => {
    const inbound = new FakeInboundChannel();
    const handlers: EmailAutomationHandler[] = [];
    const ctx = createPluginContext();
    ctx.provide(capabilities.appLogger, silentLogger);
    ctx.provide(capabilities.emailSender, new FakeEmailSender());
    ctx.provide(capabilities.emailInbox, fakeInbox);
    ctx.provide(capabilities.whatsappInbound, inbound);
    ctx.provide(capabilities.whatsappChatSender, new FakeWhatsAppChatSender());
    ctx.provide(capabilities.threadStore, new FakeThreadStore());
    ctx.provide(capabilities.emailAutomationHandlers, handlers);

    await registerPlugins([
      createWhatsAppEmailBridgePlugin(config({
        emailToWhatsapp: { enabled: false },
      })),
    ], ctx);

    expect(inbound.handlers).toHaveLength(1);
    expect(handlers).toHaveLength(0);
  });

  it("prepares WA command feedback labels before registering the email command workflow", async () => {
    const inbox = new FakeCommandInbox();
    const handlers: EmailAutomationHandler[] = [];
    const ctx = createPluginContext();
    ctx.provide(capabilities.appLogger, silentLogger);
    ctx.provide(capabilities.emailSender, new FakeEmailSender());
    ctx.provide(capabilities.emailInbox, inbox);
    ctx.provide(capabilities.whatsappSender, new FakeWhatsAppSender());
    ctx.provide(capabilities.emailAutomationHandlers, handlers);

    await registerPlugins([createEmailCommandToWhatsAppPlugin(config())], ctx);

    expect(inbox.labels).toEqual([["WA/Sent", "WA/Failed"]]);
    expect(handlers).toHaveLength(1);
  });
});

const silentLogger: AppLogger = {
  info() {},
};

const fakeInbox: EmailInbox = {
  async fetchUnread() {
    return [];
  },
  async markProcessed() {},
};

type ConfigOverrides = Omit<Partial<AppConfig>, "emailToWhatsapp" | "transactionCategoryRequest"> & {
  emailToWhatsapp?: Partial<AppConfig["emailToWhatsapp"]>;
  transactionCategoryRequest?: Partial<AppConfig["transactionCategoryRequest"]>;
};

function config(overrides: ConfigOverrides = {}): AppConfig {
  return {
    whatsapp: {
      phoneNumber: "972501234567",
      forwardStatuses: { enabled: false, whitelist: [], blacklist: [] },
      forwardGroups: { enabled: false, whitelist: [], blacklist: [] },
    },
    smtp: {
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "bot@example.com",
      pass: "secret",
    },
    email: {
      from: "bot@example.com",
      to: "owner@example.com",
      messageIdDomain: "message-automation-hub.local",
    },
    imap: {
      host: "imap.example.com",
      port: 993,
      secure: true,
      user: "bot@example.com",
      pass: "secret",
    },
    emailToWhatsapp: {
      enabled: true,
      subjectPrefix: "WA:",
      pollIntervalMs: 30_000,
      ...overrides.emailToWhatsapp,
    },
    transactionCategoryRequest: {
      enabled: false,
      subjectPrefix: "TXCAT:",
      recipientPhoneNumber: "",
      ...overrides.transactionCategoryRequest,
    },
  };
}

function whatsappMessage(): InboundMessage {
  const sender: ContactRef = {
    id: "chat-1",
    displayName: "Alice",
  };

  return {
    id: "message-1",
    channel: "whatsapp",
    from: sender,
    text: "Hello",
    receivedAt: new Date("2026-07-12T10:00:00.000Z"),
  };
}
