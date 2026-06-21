import { describe, expect, it } from "vitest";
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
