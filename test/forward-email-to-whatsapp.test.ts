import { describe, expect, it } from "vitest";
import type { InboundEmail } from "../src/domain/email.js";
import type { EmailInbox } from "../src/ports/email-inbox.js";
import type {
  WhatsAppDirectMessage,
  WhatsAppSender,
} from "../src/ports/whatsapp-sender.js";
import { ForwardEmailToWhatsApp } from "../src/use-cases/forward-email-to-whatsapp.js";

class FakeEmailInbox implements EmailInbox {
  readonly processed: InboundEmail[] = [];

  constructor(private readonly emails: InboundEmail[]) {}

  async fetchUnread(): Promise<InboundEmail[]> {
    return this.emails;
  }

  async markProcessed(email: InboundEmail): Promise<void> {
    this.processed.push(email);
  }
}

class FakeWhatsAppSender implements WhatsAppSender {
  readonly sent: WhatsAppDirectMessage[] = [];

  async sendMessage(message: WhatsAppDirectMessage): Promise<void> {
    this.sent.push(message);
  }
}

describe("ForwardEmailToWhatsApp", () => {
  it("sends matching emails to the phone number declared in the body", async () => {
    const email = emailCommand({
      subject: "WA: please send",
      text: ["To: +1 (202) 555-0108", "", "Can you call me?"].join("\n"),
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
    });

    await forwarder.processUnread();

    expect(whatsapp.sent).toEqual([
      {
        phoneNumber: "12025550108",
        text: "Can you call me?",
      },
    ]);
    expect(inbox.processed).toEqual([email]);
  });

  it("ignores unread emails with a different subject prefix", async () => {
    const email = emailCommand({
      subject: "hello",
      text: ["To: 12025550108", "", "Ignore this"].join("\n"),
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
    });

    await forwarder.processUnread();

    expect(whatsapp.sent).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });

  it("does not mark matching email as processed when WhatsApp sending fails", async () => {
    const email = emailCommand({
      subject: "WA: please send",
      text: ["To: 12025550108", "", "Can you call me?"].join("\n"),
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp: WhatsAppSender = {
      async sendMessage() {
        throw new Error("send failed");
      },
    };
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
    });

    await expect(forwarder.processUnread()).rejects.toThrow("send failed");

    expect(inbox.processed).toEqual([]);
  });
});

function emailCommand(overrides: Partial<InboundEmail>): InboundEmail {
  return {
    id: "email-1",
    from: "me@example.com",
    subject: "",
    text: "",
    receivedAt: new Date("2026-06-21T08:00:00.000Z"),
    ...overrides,
  };
}
