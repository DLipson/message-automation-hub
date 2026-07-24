import { describe, expect, it } from "vitest";
import type { InboundEmail } from "../src/domain/email.js";
import type { AppLogger } from "../src/ports/app-logger.js";
import type { EmailInbox } from "../src/ports/email-inbox.js";
import type { EmailMessage, EmailSender } from "../src/ports/email-sender.js";
import type {
  SentMessage,
  WhatsAppChatMessage,
  WhatsAppChatSender,
} from "../src/ports/whatsapp-sender.js";
import { FakeEmailInbox } from "./fakes/fake-email-inbox.js";
import { ReplyEmailToWhatsApp } from "../src/use-cases/reply-email-to-whatsapp.js";
import {
  replyMarker,
  type WhatsAppEmailThread,
  type WhatsAppEmailThreadStore,
} from "../src/use-cases/whatsapp-email-thread-store.js";

class FakeWhatsApp implements WhatsAppChatSender {
  readonly sent: WhatsAppChatMessage[] = [];

  constructor(private readonly error?: Error) {}

  async sendChatMessage(message: WhatsAppChatMessage): Promise<SentMessage> {
    if (this.error) {
      throw this.error;
    }

    this.sent.push(message);
    return { delivery: new Promise(() => {}) };
  }
}

class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

class FakeLogger implements AppLogger {
  readonly messages: string[] = [];

  info(message: string): void {
    this.messages.push(message);
  }
}

class FakeThreadStore implements WhatsAppEmailThreadStore {
  constructor(private readonly thread: WhatsAppEmailThread) {}

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

const thread: WhatsAppEmailThread = {
  token: "abc123",
  chatId: "127513921597547@lid",
  subject: "WhatsApp: Alice [wa:abc123]",
  rootMessageId: "<wa.abc123@message-automation-hub.local>",
};

describe("ReplyEmailToWhatsApp", () => {
  it("sends an email reply matched by subject token back to the stored WhatsApp chat", async () => {
    const email = emailCommand({
      subject: "Re: WhatsApp: Alice [wa:abc123]",
      text: ["Sure, I can do that.", "", replyMarker, "", "quoted text"].join("\n"),
    });
    const inbox = new FakeEmailInbox();
    const whatsapp = new FakeWhatsApp();
    const handler = new ReplyEmailToWhatsApp(
      inbox,
      whatsapp,
      new FakeThreadStore(thread),
    );

    await expect(handler.handle(email, { sentWhatsAppImage: false })).resolves.toBe(true);

    expect(whatsapp.sent).toEqual([{
      chatId: "127513921597547@lid",
      text: "Sure, I can do that.",
    }]);
    expect(inbox.processed).toEqual([email]);
  });

  it("matches replies by the generated forwarded Message-ID when the subject token is missing", async () => {
    const email = emailCommand({
      subject: "Re: WhatsApp conversation",
      text: "Header-only reply",
      inReplyTo: "<wa.abc123.bWVzc2FnZS0x@message-automation-hub.local>",
    });
    const inbox = new FakeEmailInbox();
    const whatsapp = new FakeWhatsApp();
    const handler = new ReplyEmailToWhatsApp(
      inbox,
      whatsapp,
      new FakeThreadStore(thread),
    );

    await expect(handler.handle(email, { sentWhatsAppImage: false })).resolves.toBe(true);

    expect(whatsapp.sent).toEqual([{
      chatId: "127513921597547@lid",
      text: "Header-only reply",
    }]);
  });

  it("matches replies by References when In-Reply-To is not the stored thread id", async () => {
    const email = emailCommand({
      subject: "Re: WhatsApp conversation",
      text: "Reference match",
      inReplyTo: "<some-client-message@example.com>",
      references: ["<some-client-message@example.com>", thread.rootMessageId],
    });
    const inbox = new FakeEmailInbox();
    const whatsapp = new FakeWhatsApp();
    const handler = new ReplyEmailToWhatsApp(
      inbox,
      whatsapp,
      new FakeThreadStore(thread),
    );

    await expect(handler.handle(email, { sentWhatsAppImage: false })).resolves.toBe(true);

    expect(whatsapp.sent).toEqual([{
      chatId: "127513921597547@lid",
      text: "Reference match",
    }]);
  });

  it("marks empty thread replies processed without sending WhatsApp", async () => {
    const email = emailCommand({
      subject: "Re: WhatsApp: Alice [wa:abc123]",
      text: ["   ", replyMarker, "quoted text"].join("\n"),
    });
    const inbox = new FakeEmailInbox();
    const whatsapp = new FakeWhatsApp();
    const logger = new FakeLogger();
    const handler = new ReplyEmailToWhatsApp(
      inbox,
      whatsapp,
      new FakeThreadStore(thread),
      logger,
    );

    await expect(handler.handle(email, { sentWhatsAppImage: false })).resolves.toBe(true);

    expect(whatsapp.sent).toEqual([]);
    expect(inbox.processed).toEqual([email]);
    expect(logger.messages).toEqual([
      "Ignored empty WhatsApp thread reply email email-1.",
    ]);
  });

  it("sends a failure notification email when WhatsApp sending fails", async () => {
    const email = emailCommand({
      subject: "Re: WhatsApp: Alice [wa:abc123]",
      text: "Please retry later",
    });
    const inbox = new FakeEmailInbox();
    const notifier = new FakeEmailSender();
    const handler = new ReplyEmailToWhatsApp(
      inbox,
      new FakeWhatsApp(new Error("send failed")),
      new FakeThreadStore(thread),
      undefined,
      {
        failureNotification: {
          sender: notifier,
          from: "bot@example.com",
          to: "owner@example.com",
        },
      },
    );

    await expect(handler.handle(email, { sentWhatsAppImage: false })).resolves.toBe(true);

    expect(inbox.processed).toEqual([]);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({
      from: "bot@example.com",
      to: "owner@example.com",
      subject: "WA reply failed: 127513921597547@lid",
      text: expect.stringContaining("Message Automation Hub could not send a WhatsApp reply."),
    });
  });

  it("ignores the bot's own forwarded emails by generated Message-ID", async () => {
    const inbox = new FakeEmailInbox();
    const whatsapp = new FakeWhatsApp();
    const handler = new ReplyEmailToWhatsApp(
      inbox,
      whatsapp,
      new FakeThreadStore(thread),
      undefined,
      { ignoreFrom: "bot@example.com" },
    );

    await expect(handler.handle(emailCommand({
      from: "Message Hub <bot@example.com>",
      messageId: "<wa.abc123.bWVzc2FnZS0x@message-automation-hub.local>",
      subject: "WhatsApp: Alice [wa:abc123]",
      text: "Alice:\n\nOriginal message",
    }), { sentWhatsAppImage: false })).resolves.toBe(false);

    expect(whatsapp.sent).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });

  it("ignores the bot's own forwarded emails by configured sender", async () => {
    const inbox = new FakeEmailInbox();
    const whatsapp = new FakeWhatsApp();
    const handler = new ReplyEmailToWhatsApp(
      inbox,
      whatsapp,
      new FakeThreadStore(thread),
      undefined,
      { ignoreFrom: "bot@example.com" },
    );

    await expect(handler.handle(emailCommand({
      from: "Message Hub <bot@example.com>",
      subject: "WhatsApp: Alice [wa:abc123]",
      text: "Alice:\n\nOriginal message",
    }), { sentWhatsAppImage: false })).resolves.toBe(false);

    expect(whatsapp.sent).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });

  it("ignores emails with unknown thread tokens", async () => {
    const inbox = new FakeEmailInbox();
    const whatsapp = new FakeWhatsApp();
    const handler = new ReplyEmailToWhatsApp(
      inbox,
      whatsapp,
      new FakeThreadStore(thread),
    );

    await expect(handler.handle(emailCommand({
      subject: "Re: WhatsApp: Someone [wa:missing]",
      text: "Do not send",
    }), { sentWhatsAppImage: false })).resolves.toBe(false);

    expect(whatsapp.sent).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });

  it("ignores non-thread emails", async () => {
    const inbox = new FakeEmailInbox();
    const whatsapp = new FakeWhatsApp();
    const handler = new ReplyEmailToWhatsApp(
      inbox,
      whatsapp,
      new FakeThreadStore(thread),
    );

    await expect(handler.handle(emailCommand({ subject: "hello" }), {
      sentWhatsAppImage: false,
    })).resolves.toBe(false);

    expect(whatsapp.sent).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });
});

function emailCommand(overrides: Partial<InboundEmail>): InboundEmail {
  return {
    id: "email-1",
    subject: "",
    text: "",
    receivedAt: new Date("2026-06-21T08:00:00.000Z"),
    ...overrides,
  };
}
