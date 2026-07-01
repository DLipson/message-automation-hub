import { describe, expect, it } from "vitest";
import type { MediaAttachment } from "../src/domain/media.js";
import type { EmailMessage, EmailSender } from "../src/ports/email-sender.js";
import type { AppLogger } from "../src/ports/app-logger.js";
import { ForwardMessageToEmail } from "../src/use-cases/forward-message-to-email.js";

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