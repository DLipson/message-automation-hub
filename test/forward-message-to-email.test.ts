import { describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../src/ports/email-sender.js";
import { ForwardMessageToEmail } from "../src/use-cases/forward-message-to-email.js";

class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

describe("ForwardMessageToEmail", () => {
  it("forwards a WhatsApp message to the configured email recipient", async () => {
    const emailSender = new FakeEmailSender();
    const forwarder = new ForwardMessageToEmail(emailSender, {
      from: "bot@example.com",
      to: "me@example.com",
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
        subject: "WhatsApp message from A Friend",
        text: [
          "From: A Friend (12025550108@c.us)",
          "Received: 2026-06-21T08:00:00.000Z",
          "",
          "Can you call me?",
        ].join("\n"),
      },
    ]);
  });

  it("does not send an email for an empty message", async () => {
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
    });

    expect(emailSender.sent).toEqual([]);
  });
});
