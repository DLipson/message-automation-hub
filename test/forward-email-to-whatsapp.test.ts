import { describe, expect, it } from "vitest";
import type { InboundEmail } from "../src/domain/email.js";
import type { MediaAttachment } from "../src/domain/media.js";
import type { AppLogger } from "../src/ports/app-logger.js";
import type { EmailInbox } from "../src/ports/email-inbox.js";
import type { EmailMessage, EmailSender } from "../src/ports/email-sender.js";
import type {
  WhatsAppDirectImage,
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

class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
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

class FakeLogger implements AppLogger {
  readonly messages: string[] = [];

  info(message: string): void {
    this.messages.push(message);
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
    const logger = new FakeLogger();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
    }, logger);

    await forwarder.processUnread();

    expect(whatsapp.sent).toEqual([
      {
        phoneNumber: "12025550108",
        text: "Can you call me?",
      },
    ]);
    expect(whatsapp.sentImages).toEqual([]);
    expect(inbox.processed).toEqual([email]);
    expect(logger.messages).toEqual([
      'Detected command email email-1 with subject "WA: please send".',
      "Forwarding email email-1 to WhatsApp number 12025550108.",
      "Forwarded email email-1 to WhatsApp number 12025550108.",
    ]);
  });

  it("sends one image attachment from a matching email", async () => {
    const image = imageAttachment("photo.jpg");
    const email = emailCommand({
      subject: "WA: image",
      text: ["To: 12025550108", "", "Nice view"].join("\n"),
      attachments: [image],
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
    });

    await forwarder.processUnread();

    expect(whatsapp.sent).toEqual([]);
    expect(whatsapp.sentImages).toEqual([
      {
        phoneNumber: "12025550108",
        text: "Nice view",
        image,
      },
    ]);
    expect(inbox.processed).toEqual([email]);
  });

  it("emails the sender when extra image attachments are skipped", async () => {
    const firstImage = imageAttachment("first.jpg");
    const secondImage = imageAttachment("second.jpg");
    const email = emailCommand({
      from: "Sender <sender@example.com>",
      subject: "WA: image",
      text: ["To: 12025550108", "", "Nice view"].join("\n"),
      attachments: [firstImage, secondImage],
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const notificationSender = new FakeEmailSender();
    const logger = new FakeLogger();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
      extraImageNotification: {
        sender: notificationSender,
        from: "bot@example.com",
      },
    }, logger);

    await forwarder.processUnread();

    expect(whatsapp.sentImages).toEqual([
      {
        phoneNumber: "12025550108",
        text: "Nice view",
        image: firstImage,
      },
    ]);
    expect(notificationSender.sent).toEqual([
      {
        from: "bot@example.com",
        to: "Sender <sender@example.com>",
        subject: "Only one image was sent to WhatsApp",
        text: [
          'Your email "WA: image" had 2 image attachments.',
          "",
          "Message Automation Hub sent the first image to WhatsApp and skipped the remaining image attachment(s).",
        ].join("\n"),
      },
    ]);
    expect(logger.messages).toContain(
      "Email email-1 has 1 extra image attachment(s); sending the first image only.",
    );
    expect(logger.messages).toContain(
      "Sent extra-image notice for email email-1 to Sender <sender@example.com>.",
    );
  });

  it("does not resend WhatsApp image when extra-image notification fails", async () => {
    const email = emailCommand({
      from: "sender@example.com",
      subject: "WA: image",
      text: ["To: 12025550108", "", "Nice view"].join("\n"),
      attachments: [imageAttachment("first.jpg"), imageAttachment("second.jpg")],
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const logger = new FakeLogger();
    const failingNotifier: EmailSender = {
      async send() {
        throw new Error("smtp unavailable");
      },
    };
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
      extraImageNotification: {
        sender: failingNotifier,
        from: "bot@example.com",
      },
    }, logger);

    await forwarder.processUnread();

    expect(whatsapp.sentImages).toHaveLength(1);
    expect(inbox.processed).toEqual([email]);
    expect(logger.messages).toContain(
      "Could not send extra-image notice for email email-1: smtp unavailable",
    );
  });

  it("waits between multiple image emails", async () => {
    const firstEmail = emailCommand({
      id: "email-1",
      subject: "WA: first image",
      text: ["To: 12025550108", "", "First"].join("\n"),
      attachments: [imageAttachment("first.jpg")],
    });
    const secondEmail = emailCommand({
      id: "email-2",
      subject: "WA: second image",
      text: ["To: 12025550108", "", "Second"].join("\n"),
      attachments: [imageAttachment("second.jpg")],
    });
    const waits: number[] = [];
    const inbox = new FakeEmailInbox([firstEmail, secondEmail]);
    const whatsapp = new FakeWhatsAppSender();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
      imageDelayMs: () => 240_000,
      wait: async milliseconds => {
        waits.push(milliseconds);
      },
    });

    await forwarder.processUnread();

    expect(waits).toEqual([240_000]);
    expect(whatsapp.sentImages).toHaveLength(2);
    expect(inbox.processed).toEqual([firstEmail, secondEmail]);
  });

  it("ignores unread emails with a different subject prefix", async () => {
    const email = emailCommand({
      subject: "hello",
      text: ["To: 12025550108", "", "Ignore this"].join("\n"),
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const logger = new FakeLogger();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
    }, logger);

    await forwarder.processUnread();

    expect(whatsapp.sent).toEqual([]);
    expect(whatsapp.sentImages).toEqual([]);
    expect(inbox.processed).toEqual([]);
    expect(logger.messages).toEqual([]);
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
      async sendImage() {},
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

function imageAttachment(filename: string): MediaAttachment {
  return {
    filename,
    contentType: "image/jpeg",
    content: Buffer.from("image"),
  };
}