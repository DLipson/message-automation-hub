import { describe, expect, it } from "vitest";
import type { MediaAttachment } from "../src/domain/media.js";
import type { EmailMessage, EmailSender } from "../src/ports/email-sender.js";
import type { AppLogger } from "../src/ports/app-logger.js";
import { ForwardMessageToEmail, formatBytes } from "../src/use-cases/forward-message-to-email.js";
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
    subject: "WhatsApp message from Alice - 127513921597547@lid [wa:lid123]",
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
    subject: "WhatsApp message from A Friend - 12025550108 [wa:abc123]",
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
      threadStore: new FakeThreadStore(),
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
        subject: "WhatsApp message from A Friend - 12025550108 [wa:abc123]",
        messageId: "<wa.abc123.bWVzc2FnZS0x@message-automation-hub.local>",
        inReplyTo: "<wa.abc123@message-automation-hub.local>",
        references: ["<wa.abc123@message-automation-hub.local>"],
        text: [
          "Can you call me?",
          "",
          "Received: 21 Jun 2026, 08:00 UTC",
          "",
          replyMarker,
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
        subject: "WhatsApp message from A Friend - 12025550108 [wa:abc123]",
        messageId: "<wa.abc123.bWVzc2FnZS0x@message-automation-hub.local>",
        inReplyTo: "<wa.abc123@message-automation-hub.local>",
        references: ["<wa.abc123@message-automation-hub.local>"],
        text: [
          "Can you call me?",
          "",
          "Received: 21 Jun 2026, 08:00 UTC",
          "",
          replyMarker,
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
      displayName: "Alice - 127513921597547@lid",
    }]);
    expect(emailSender.sent[0]?.subject).toBe(
      "WhatsApp message from Alice - 127513921597547@lid [wa:lid123]",
    );
  });

  it("forwards up to five WhatsApp attachments", async () => {
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
      threadStore: new FakeThreadStore(),
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
        subject: "WhatsApp message from A Friend - 12025550108 [wa:abc123]",
        messageId: "<wa.abc123.bWVzc2FnZS0x@message-automation-hub.local>",
        inReplyTo: "<wa.abc123@message-automation-hub.local>",
        references: ["<wa.abc123@message-automation-hub.local>"],
        text: [
          "Photos",
          "",
          "Received: 21 Jun 2026, 08:00 UTC",
          "",
          "Note: 1 additional attachment(s) were not forwarded because the per-message limit is 5.",
          "",
          replyMarker,
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
      threadStore: new FakeThreadStore(),
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

  it("forwards non-image WhatsApp attachments", async () => {
    const attachments = [
      mediaAttachment("invoice.pdf", "application/pdf"),
      mediaAttachment("voice-note.ogg", "audio/ogg; codecs=opus"),
    ];
    const emailSender = new FakeEmailSender();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
      threadStore: new FakeThreadStore(),
    });

    await forwarder.handle({
      id: "message-1",
      channel: "whatsapp",
      from: { id: "12025550108@c.us" },
      text: "   ",
      receivedAt: new Date("2026-06-21T08:00:00.000Z"),
      attachments,
    });

    expect(emailSender.sent[0]?.attachments).toEqual(attachments);
  });

  it("skips oversized attachments and adds a note above the reply marker", async () => {
    const sizeLimit = 5 * 1024 * 1024; // 5 MB
    const small = {
      filename: "small.jpg",
      contentType: "image/jpeg",
      content: Buffer.alloc(100_000),
    };
    const large = {
      filename: "big-video.mp4",
      contentType: "video/mp4",
      content: Buffer.alloc(4 * 1024 * 1024), // 4 MB raw -> ~5.5 MB on the wire
    };
    const emailSender = new FakeEmailSender();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
      threadStore: new FakeThreadStore(),
      maxAttachmentSizeBytes: sizeLimit,
    });

    await forwarder.handle({
      id: "message-1",
      channel: "whatsapp",
      from: { id: "12025550108@c.us", displayName: "A Friend" },
      text: "Check this out",
      receivedAt: new Date("2026-06-21T08:00:00.000Z"),
      attachments: [small, large],
    });

    const sent = emailSender.sent[0]!;
    expect(sent.attachments).toEqual([small]);
    expect(sent.text).toContain(
      "Attachment not forwarded: big-video.mp4 (5.5 MB) exceeds the 5.0 MB size limit.",
    );
    // Note must appear above the reply marker so threaded clients show it
    const noteIndex = sent.text!.indexOf("Attachment not forwarded");
    const markerIndex = sent.text!.indexOf(replyMarker);
    expect(noteIndex).toBeLessThan(markerIndex);
  });

  it("passes attachments under the size limit unchanged", async () => {
    const attachment = {
      filename: "photo.jpg",
      contentType: "image/jpeg",
      content: Buffer.alloc(500),
    };
    const emailSender = new FakeEmailSender();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
      threadStore: new FakeThreadStore(),
      maxAttachmentSizeBytes: 1024,
    });

    await forwarder.handle({
      id: "message-1",
      channel: "whatsapp",
      from: { id: "12025550108@c.us", displayName: "A Friend" },
      text: "Here",
      receivedAt: new Date("2026-06-21T08:00:00.000Z"),
      attachments: [attachment],
    });

    const sent = emailSender.sent[0]!;
    expect(sent.attachments).toEqual([attachment]);
    expect(sent.text).not.toContain("Attachment not forwarded");
  });

  it("skips multiple oversized attachments while keeping small ones", async () => {
    const sizeLimit = 2 * 1024 * 1024; // 2 MB
    const small = { filename: "ok.jpg", contentType: "image/jpeg", content: Buffer.alloc(100) };
    const big1 = { filename: "huge1.mp4", contentType: "video/mp4", content: Buffer.alloc(2 * 1024 * 1024) };
    const big2 = { filename: "huge2.mp4", contentType: "video/mp4", content: Buffer.alloc(3 * 1024 * 1024) };
    const emailSender = new FakeEmailSender();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
      threadStore: new FakeThreadStore(),
      maxAttachmentSizeBytes: sizeLimit,
    });

    await forwarder.handle({
      id: "message-1",
      channel: "whatsapp",
      from: { id: "12025550108@c.us", displayName: "A Friend" },
      text: "Files",
      receivedAt: new Date("2026-06-21T08:00:00.000Z"),
      attachments: [small, big1, big2],
    });

    const sent = emailSender.sent[0]!;
    expect(sent.attachments).toEqual([small]);
    expect(sent.text).toContain("huge1.mp4");
    expect(sent.text).toContain("huge2.mp4");
  });

  it("formats small sizes as KB and large sizes as MB", () => {
    expect(formatBytes(1025)).toBe("1 KB");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(5.3 * 1024 * 1024)).toBe("5.3 MB");
  });

  it("does not send an email for an empty message", async () => {
    const emailSender = new FakeEmailSender();
    const logger = new FakeLogger();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
      threadStore: new FakeThreadStore(),
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
  return mediaAttachment(filename, "image/jpeg");
}

function mediaAttachment(filename: string, contentType: string): MediaAttachment {
  return {
    filename,
    contentType,
    content: Buffer.from(filename),
  };
}
