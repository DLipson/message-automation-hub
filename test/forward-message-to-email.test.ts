import { describe, expect, it } from "vitest";
import type { MediaAttachment } from "../src/domain/media.js";
import type { EmailMessage, EmailSender } from "../src/ports/email-sender.js";
import type { AppLogger } from "../src/ports/app-logger.js";
import { ForwardMessageToEmail } from "../src/use-cases/forward-message-to-email.js";
import {
  replyMarker,
  type WhatsAppEmailThread,
  type WhatsAppEmailThreadStore,
} from "../src/use-cases/whatsapp-email-thread-store.js";

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

class CapturingThreadStore implements WhatsAppEmailThreadStore {
  readonly created: Array<{ chatId: string; displayName: string }> = [];
  readonly thread: WhatsAppEmailThread = {
    token: "lid123",
    chatId: "127513921597547@lid",
    subject: "WhatsApp: Alice [wa:lid123]",
    rootMessageId: "<wa.lid123@message-automation-hub.local>",
  };

  async getOrCreate(chatId: string, displayName: string): Promise<WhatsAppEmailThread> {
    this.created.push({ chatId, displayName });
    return this.thread;
  }

  async findByToken(): Promise<WhatsAppEmailThread | null> {
    return this.thread;
  }

  async findByMessageId(): Promise<WhatsAppEmailThread | null> {
    return this.thread;
  }
}

class FakeThreadStore implements WhatsAppEmailThreadStore {
  readonly thread: WhatsAppEmailThread = {
    token: "abc123",
    chatId: "12025550108@c.us",
    subject: "WhatsApp: A Friend [wa:abc123]",
    rootMessageId: "<wa.abc123@message-automation-hub.local>",
  };

  async getOrCreate(): Promise<WhatsAppEmailThread> {
    return this.thread;
  }

  async findByToken(): Promise<WhatsAppEmailThread | null> {
    return this.thread;
  }

  async findByMessageId(): Promise<WhatsAppEmailThread | null> {
    return this.thread;
  }
}

describe("ForwardMessageToEmail", () => {
  it("forwards a WhatsApp message to the configured email recipient", async () => {
    const emailSender = new FakeEmailSender();
    const logger = new FakeLogger();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
    }, logger);

    await forwarder.handle({
      id: "message-1",
      channel: "whatsapp",
      from: {
        id: "12025550108@c.us",
        displayName: "A Friend",
      },
      text: "Can you call me?",
      receivedAt: new Date("2026-06-21T08:00:00.000Z"),
    });

    expect(emailSender.sent).toEqual([
      {
        from: "bot@example.com",
        to: "me@example.com",
        subject: "WhatsApp message from A Friend",
        text: [
          "From: A Friend (12025550108@c.us)",
          "Received: 2026-06-21T08:00:00.000Z",
          "",
          "Can you call me?",
        ].join("\n"),
      },
    ]);
    expect(logger.messages).toEqual([
      "Received WhatsApp message from A Friend; forwarding to me@example.com.",
      "Forwarded WhatsApp message from A Friend to me@example.com.",
    ]);
  });

  it("adds reply-thread metadata when a thread store is configured", async () => {
    const emailSender = new FakeEmailSender();
    const threadStore = new FakeThreadStore();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
      threadStore,
    });

    await forwarder.handle({
      id: "message-1",
      channel: "whatsapp",
      from: {
        id: "12025550108@c.us",
        displayName: "A Friend",
      },
      text: "Can you call me?",
      receivedAt: new Date("2026-06-21T08:00:00.000Z"),
    });

    expect(emailSender.sent).toEqual([
      {
        from: "bot@example.com",
        to: "me@example.com",
        subject: "WhatsApp: A Friend [wa:abc123]",
        messageId: "<wa.abc123.bWVzc2FnZS0x@message-automation-hub.local>",
        inReplyTo: "<wa.abc123@message-automation-hub.local>",
        references: ["<wa.abc123@message-automation-hub.local>"],
        text: [
          "A Friend:",
          "",
          "Can you call me?",
          "",
          replyMarker,
          "",
          "From: A Friend (12025550108@c.us)",
          "Received: 2026-06-21T08:00:00.000Z",
        ].join("\n"),
      },
    ]);
  });

  it("stores the raw WhatsApp chat id for email replies", async () => {
    const emailSender = new FakeEmailSender();
    const threadStore = new CapturingThreadStore();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
      threadStore,
    });

    await forwarder.handle({
      id: "message-1",
      channel: "whatsapp",
      from: {
        id: "127513921597547@lid",
        displayName: "Alice",
      },
      text: "Can you call me?",
      receivedAt: new Date("2026-06-21T08:00:00.000Z"),
    });

    expect(threadStore.created).toEqual([{
      chatId: "127513921597547@lid",
      displayName: "Alice",
    }]);
    expect(emailSender.sent[0]?.subject).toBe("WhatsApp: Alice [wa:lid123]");
  });

  it("forwards up to five WhatsApp images as email attachments", async () => {
    const attachments = [
      imageAttachment("1.jpg"),
      imageAttachment("2.jpg"),
      imageAttachment("3.jpg"),
      imageAttachment("4.jpg"),
      imageAttachment("5.jpg"),
      imageAttachment("6.jpg"),
    ];
    const emailSender = new FakeEmailSender();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
    });

    await forwarder.handle({
      id: "message-1",
      channel: "whatsapp",
      from: { id: "12025550108@c.us", displayName: "A Friend" },
      text: "Photos",
      receivedAt: new Date("2026-06-21T08:00:00.000Z"),
      attachments,
    });

    expect(emailSender.sent).toEqual([
      {
        from: "bot@example.com",
        to: "me@example.com",
        subject: "WhatsApp message from A Friend",
        text: [
          "From: A Friend (12025550108@c.us)",
          "Received: 2026-06-21T08:00:00.000Z",
          "",
          "Photos",
          "",
          "Note: 1 additional image attachment(s) were not forwarded because the per-message limit is 5.",
        ].join("\n"),
        attachments: attachments.slice(0, 5),
      },
    ]);
  });

  it("forwards image-only WhatsApp messages", async () => {
    const attachment = imageAttachment("photo.jpg");
    const emailSender = new FakeEmailSender();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
    });

    await forwarder.handle({
      id: "message-1",
      channel: "whatsapp",
      from: { id: "12025550108@c.us" },
      text: "   ",
      receivedAt: new Date("2026-06-21T08:00:00.000Z"),
      attachments: [attachment],
    });

    expect(emailSender.sent[0]?.attachments).toEqual([attachment]);
  });

  it("does not send an email for an empty message", async () => {
    const emailSender = new FakeEmailSender();
    const logger = new FakeLogger();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
    }, logger);

    await forwarder.handle({
      id: "message-1",
      channel: "whatsapp",
      from: { id: "12025550108@c.us" },
      text: "   ",
      receivedAt: new Date("2026-06-21T08:00:00.000Z"),
    });

    expect(emailSender.sent).toEqual([]);
    expect(logger.messages).toEqual([]);
  });
});

function imageAttachment(filename: string): MediaAttachment {
  return {
    filename,
    contentType: "image/jpeg",
    content: Buffer.from(filename),
  };
}
