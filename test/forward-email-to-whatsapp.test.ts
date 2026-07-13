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
import { ProcessEmailAutomations } from "../src/use-cases/process-email-automations.js";
import { ForwardEmailToWhatsApp } from "../src/use-cases/forward-email-to-whatsapp.js";

class FakeEmailInbox implements EmailInbox {
  readonly processed: InboundEmail[] = [];
  readonly sent: InboundEmail[] = [];
  readonly failed: InboundEmail[] = [];

  constructor(private readonly emails: InboundEmail[]) {}

  async fetchUnread(): Promise<InboundEmail[]> {
    return this.emails;
  }

  async markProcessed(email: InboundEmail): Promise<void> {
    this.processed.push(email);
  }

  async markSent(email: InboundEmail): Promise<void> {
    this.sent.push(email);
  }

  async markFailed(email: InboundEmail): Promise<void> {
    this.failed.push(email);
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
  it("sends matching emails to the phone number declared in the subject", async () => {
    const email = emailCommand({
      subject: "wa+1 (202) 555-0108",
      text: "Can you call me?",
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const logger = new FakeLogger();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
    }, logger);

    await new ProcessEmailAutomations(inbox, [forwarder]).processUnread();

    expect(whatsapp.sent).toEqual([
      {
        phoneNumber: "12025550108",
        text: "Can you call me?",
      },
    ]);
    expect(whatsapp.sentImages).toEqual([]);
    expect(inbox.processed).toEqual([email]);
    expect(inbox.sent).toEqual([email]);
    expect(inbox.failed).toEqual([]);
    expect(logger.messages).toEqual([
      'Detected command email email-1 with subject "wa+1 (202) 555-0108".',
      "Forwarding email email-1 to WhatsApp number 12025550108.",
      "Forwarded email email-1 to WhatsApp number 12025550108.",
    ]);
  });

  it("sends one image attachment from a matching email", async () => {
    const image = imageAttachment("photo.jpg");
    const email = emailCommand({
      subject: "WA: 12025550108",
      text: "Nice view",
      attachments: [image],
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
    });

    await new ProcessEmailAutomations(inbox, [forwarder]).processUnread();

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
      subject: "WA: 12025550108",
      text: "Nice view",
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

    await new ProcessEmailAutomations(inbox, [forwarder]).processUnread();

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
          'Your email "WA: 12025550108" had 2 image attachments.',
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
      subject: "WA: 12025550108",
      text: "Nice view",
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

    await new ProcessEmailAutomations(inbox, [forwarder]).processUnread();

    expect(whatsapp.sentImages).toHaveLength(1);
    expect(inbox.processed).toEqual([email]);
    expect(logger.messages).toContain(
      "Could not send extra-image notice for email email-1: smtp unavailable",
    );
  });

  it("waits between multiple image emails", async () => {
    const firstEmail = emailCommand({
      id: "email-1",
      subject: "WA: 12025550108",
      text: "First",
      attachments: [imageAttachment("first.jpg")],
    });
    const secondEmail = emailCommand({
      id: "email-2",
      subject: "WA: 12025550108",
      text: "Second",
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

    await new ProcessEmailAutomations(inbox, [forwarder]).processUnread();

    expect(waits).toEqual([240_000]);
    expect(whatsapp.sentImages).toHaveLength(2);
    expect(inbox.processed).toEqual([firstEmail, secondEmail]);
  });

  it("ignores unread emails with a different subject prefix", async () => {
    const email = emailCommand({
      subject: "hello",
      text: "Ignore this",
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const logger = new FakeLogger();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
    }, logger);

    await new ProcessEmailAutomations(inbox, [forwarder]).processUnread();

    expect(whatsapp.sent).toEqual([]);
    expect(whatsapp.sentImages).toEqual([]);
    expect(inbox.processed).toEqual([]);
    expect(logger.messages).toEqual([]);
  });

  it("ignores WA subjects with letters or too few digits after the prefix", async () => {
    const emails = [
      emailCommand({ id: "email-1", subject: "wa123abc456", text: "No" }),
      emailCommand({ id: "email-2", subject: "wa123456", text: "No" }),
      emailCommand({ id: "email-3", subject: "wa1234567foo", text: "No" }),
      emailCommand({ id: "email-4", subject: "water", text: "No" }),
    ];
    const inbox = new FakeEmailInbox(emails);
    const whatsapp = new FakeWhatsAppSender();
    const logger = new FakeLogger();
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
    }, logger);

    await new ProcessEmailAutomations(inbox, [forwarder]).processUnread();

    expect(whatsapp.sent).toEqual([]);
    expect(whatsapp.sentImages).toEqual([]);
    expect(inbox.processed).toEqual([]);
    expect(logger.messages).toEqual([]);
  });

  it("marks failed command emails and sends a separate failure email", async () => {
    const email = emailCommand({
      subject: "WA: 12025550108",
      text: "Can you call me?",
    });
    const inbox = new FakeEmailInbox([email]);
    const notificationSender = new FakeEmailSender();
    const whatsapp: WhatsAppSender = {
      async sendMessage() {
        throw new Error("send failed");
      },
      async sendImage() {},
    };
    const forwarder = new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: "WA:",
      failureNotification: {
        sender: notificationSender,
        from: "bot@example.com",
        to: "owner@example.com",
      },
    });

    await expect(new ProcessEmailAutomations(inbox, [forwarder]).processUnread()).rejects.toThrow("send failed");

    expect(inbox.processed).toEqual([email]);
    expect(inbox.failed).toEqual([email]);
    expect(inbox.sent).toEqual([]);
    expect(notificationSender.sent).toHaveLength(1);
    expect(notificationSender.sent[0]).toMatchObject({
      from: "bot@example.com",
      to: "owner@example.com",
      subject: "WA send failed: 12025550108",
      text: expect.stringContaining([
        "Message Automation Hub could not send a WhatsApp command email.",
        "",
        "Target: 12025550108",
        "Email subject: WA: 12025550108",
        "Email id: email-1",
        "Time: 2026-06-21T08:00:00.000Z",
        "",
        "Message:",
        "Can you call me?",
        "",
        "Error:",
        "Error: send failed",
      ].join("\n")),
    });
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
