import { describe, expect, it } from "vitest";
import type { InboundMessage, ContactRef } from "@message-automation/core/api/index.js";
import type { EmailInbox } from "@message-automation/core/api/index.js";
import type { EmailMessage, EmailSender } from "@message-automation/core/api/index.js";
import type { InboundChannel, InboundMessageHandler } from "@message-automation/core/api/index.js";
import type { AppLogger } from "@message-automation/core/api/index.js";
import type {
  SentMessage,
  WhatsAppChatMessage,
  WhatsAppChatSender,
  WhatsAppDirectImage,
  WhatsAppDirectMessage,
  WhatsAppSender,
} from "@message-automation/core/api/index.js";
import type {
  WhatsAppEmailThread,
  WhatsAppEmailThreadStore,
} from "@message-automation/core/api/index.js";
import { FakeEmailInbox } from "./fakes/fake-email-inbox.js";
import { createPluginContext, registerPlugins } from "../../core/src/core/plugin-runtime.js";
import { capabilities } from "../src/capabilities.js";
import { plugin as emailCommandPlugin } from "../src/workflows/email-command-to-whatsapp.js";
import { createWhatsAppEmailBridgePlugin } from "../../core/src/plugins/workflows/whatsapp-email-bridge.js";
import { plugin as txcatPlugin } from "../src/workflows/transaction-category-request.js";

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

  async sendChatMessage(message: WhatsAppChatMessage): Promise<SentMessage> {
    this.sent.push(message);
    return { delivery: new Promise(() => {}) };
  }
}

class FakeWhatsAppSender implements WhatsAppSender {
  readonly sent: WhatsAppDirectMessage[] = [];
  readonly sentImages: WhatsAppDirectImage[] = [];

  async sendMessage(message: WhatsAppDirectMessage): Promise<SentMessage> {
    this.sent.push(message);
    return { delivery: new Promise(() => {}) };
  }

  async sendImage(message: WhatsAppDirectImage): Promise<SentMessage> {
    this.sentImages.push(message);
    return { delivery: new Promise(() => {}) };
  }
}

class FakeCommandInbox extends FakeEmailInbox {
  readonly labels: string[][] = [];

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
    const chatSender = new FakeWhatsAppChatSender();
    const ctx = createPluginContext();
    ctx.provide(capabilities.appLogger, silentLogger);
    ctx.provide(capabilities.emailSender, emailSender);
    ctx.provide(capabilities.emailInbox, fakeInbox);
    ctx.provide(capabilities.whatsappInbound, inbound);
    ctx.provide(capabilities.whatsappChatSender, chatSender);
    ctx.provide(capabilities.threadStore, new FakeThreadStore());

    await registerPlugins([createWhatsAppEmailBridgePlugin(bridgeConfig())], ctx);

    expect(inbound.handlers).toHaveLength(1);

    await inbound.handlers[0]?.(whatsappMessage());

    expect(emailSender.sent[0]?.subject).toBe("WhatsApp thread [wa:thread-token]");

    const handled = await ctx.emit("email.received", {
      email: {
        id: "reply-1",
        subject: "Re: WhatsApp thread [wa:thread-token]",
        text: "Sure, I'll do that.",
        receivedAt: new Date("2026-07-12T10:00:00.000Z"),
      },
      batch: { sentWhatsAppImage: false },
    });
    expect(handled).toBe(true);
    expect(chatSender.sent).toHaveLength(1);
    expect(chatSender.sent[0]?.chatId).toBe("chat-1");
    expect(chatSender.sent[0]?.text).toBe("Sure, I'll do that.");
  });

  it("keeps the bridge inbound leg when email-to-WhatsApp polling is disabled", async () => {
    const inbound = new FakeInboundChannel();
    const ctx = createPluginContext({ emailToWhatsapp: { enabled: false } });
    ctx.provide(capabilities.appLogger, silentLogger);
    ctx.provide(capabilities.emailSender, new FakeEmailSender());
    ctx.provide(capabilities.emailInbox, fakeInbox);
    ctx.provide(capabilities.whatsappInbound, inbound);
    ctx.provide(capabilities.whatsappChatSender, new FakeWhatsAppChatSender());
    ctx.provide(capabilities.threadStore, new FakeThreadStore());

    await registerPlugins([createWhatsAppEmailBridgePlugin(bridgeConfig({ emailToWhatsapp: { enabled: false } }))], ctx);

    expect(inbound.handlers).toHaveLength(1);

    const handled = await ctx.emit("email.received", {
      email: {
        id: "reply-2",
        subject: "Re: WhatsApp thread [wa:thread-token]",
        text: "Reply",
        receivedAt: new Date(),
      },
      batch: { sentWhatsAppImage: false },
    });
    expect(handled).toBe(false);
  });

  it("prepares WA command feedback labels before registering the email command workflow", async () => {
    const inbox = new FakeCommandInbox();
    const sender = new FakeWhatsAppSender();
    const ctx = createPluginContext({
      email: { from: "bot@example.com", to: "owner@example.com" },
      emailToWhatsapp: { enabled: true, subjectPrefix: "WA:" },
    });
    ctx.provide(capabilities.appLogger, silentLogger);
    ctx.provide(capabilities.emailSender, new FakeEmailSender());
    ctx.provide(capabilities.emailInbox, inbox);
    ctx.provide(capabilities.emailLabeler, inbox);
    ctx.provide(capabilities.emailStatusMarker, inbox);
    ctx.provide(capabilities.whatsappSender, sender);

    await registerPlugins([emailCommandPlugin], ctx);

    expect(inbox.labels).toEqual([["WA/Sent", "WA/Delivered", "WA/Failed"]]);

    const handled = await ctx.emit("email.received", {
      email: {
        id: "cmd-1",
        subject: "WA: 972501234567",
        text: "Hello",
        receivedAt: new Date(),
      },
      batch: { sentWhatsAppImage: false },
    });
    expect(handled).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.phoneNumber).toBe("972501234567");
  });

  it("dispatches each email type to the correct handler among all registered plugins", async () => {
    const inbound = new FakeInboundChannel();
    const emailSender = new FakeEmailSender();
    const chatSender = new FakeWhatsAppChatSender();
    const sender = new FakeWhatsAppSender();
    const inbox = new FakeCommandInbox();
    const ctx = createPluginContext({
      email: { from: "bot@example.com", to: "owner@example.com" },
      emailToWhatsapp: { enabled: true, subjectPrefix: "WA:" },
      transactionCategoryRequest: {
        enabled: true,
        subjectPrefix: "TXCAT:",
        recipientPhoneNumber: "972501234567",
      },
    });
    ctx.provide(capabilities.appLogger, silentLogger);
    ctx.provide(capabilities.emailSender, emailSender);
    ctx.provide(capabilities.emailInbox, inbox);
    ctx.provide(capabilities.emailLabeler, inbox);
    ctx.provide(capabilities.emailStatusMarker, inbox);
    ctx.provide(capabilities.whatsappInbound, inbound);
    ctx.provide(capabilities.whatsappChatSender, chatSender);
    ctx.provide(capabilities.whatsappSender, sender);
    ctx.provide(capabilities.threadStore, new FakeThreadStore());

    await registerPlugins([
      createWhatsAppEmailBridgePlugin(bridgeConfig()),
      emailCommandPlugin,
      txcatPlugin,
    ], ctx);

    // WA command email — handled by ForwardEmailToWhatsApp (second plugin)
    const cmdHandled = await ctx.emit("email.received", {
      email: {
        id: "cmd-1",
        subject: "WA: 972501234567",
        text: "Hello",
        receivedAt: new Date(),
      },
      batch: { sentWhatsAppImage: false },
    });
    expect(cmdHandled).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.phoneNumber).toBe("972501234567");

    // TXCAT email with CSV attachment — handled by txcat (third plugin)
    const txcatHandled = await ctx.emit("email.received", {
      email: {
        id: "txcat-1",
        subject: "TXCAT: request",
        text: "",
        attachments: [{
          filename: "transactions.csv",
          contentType: "text/csv",
          content: Buffer.from("Date,Payee,Outflow,Inflow\n2026-06-01,Store,₪42,₪0"),
        }],
        receivedAt: new Date(),
      },
      batch: { sentWhatsAppImage: false },
    });
    expect(txcatHandled).toBe(true);
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1]?.phoneNumber).toBe("972501234567");

    // Reply email — handled by ReplyEmailToWhatsApp (first plugin)
    const replyHandled = await ctx.emit("email.received", {
      email: {
        id: "reply-1",
        subject: "Re: WhatsApp thread [wa:thread-token]",
        text: "Sure, I'll do that.",
        receivedAt: new Date(),
      },
      batch: { sentWhatsAppImage: false },
    });
    expect(replyHandled).toBe(true);
    expect(chatSender.sent).toHaveLength(1);
    expect(chatSender.sent[0]?.chatId).toBe("chat-1");

    // Unrelated email — not handled
    const noneHandled = await ctx.emit("email.received", {
      email: {
        id: "other-1",
        subject: "Some other email",
        text: "Irrelevant",
        receivedAt: new Date(),
      },
      batch: { sentWhatsAppImage: false },
    });
    expect(noneHandled).toBe(false);
  });
});

function bridgeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    email: { from: "app@test.com", to: "user@test.com", messageIdDomain: "test.local" },
    emailToWhatsapp: { enabled: true, subjectPrefix: "WA:", pollIntervalMs: 30000 },
    ...overrides,
  };
}

const silentLogger: AppLogger = {
  info() {},
};

const fakeInbox: EmailInbox = {
  async fetchUnread() {
    return [];
  },
  async markProcessed() {},
  async watchNewMail() {
    return async () => {};
  },
};

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
