import { describe, expect, it } from "vitest";
import type { InboundEmail } from "../src/domain/email.js";
import type { MediaAttachment } from "../src/domain/media.js";
import type { EmailInbox, EmailStatusMarker } from "../src/ports/email-inbox.js";
import type {
  SentMessage,
  WhatsAppDirectImage,
  WhatsAppDirectMessage,
  WhatsAppSender,
} from "../src/ports/whatsapp-sender.js";
import {
  RequestTransactionCategoryFromEmail,
} from "../src/automations/transaction-category-request/request-from-email.js";
import { ProcessEmailAutomations } from "../src/use-cases/process-email-automations.js";

class FakeEmailInbox implements EmailInbox, EmailStatusMarker {
  readonly processed: InboundEmail[] = [];
  readonly failed: InboundEmail[] = [];

  constructor(private readonly emails: InboundEmail[]) {}

  async fetchUnread(): Promise<InboundEmail[]> {
    return this.emails;
  }

  async markProcessed(email: InboundEmail): Promise<void> {
    this.processed.push(email);
  }

  async markSent(): Promise<void> {}
  async markDelivered(): Promise<void> {}

  async markFailed(email: InboundEmail): Promise<void> {
    this.failed.push(email);
  }

  async watchNewMail(): Promise<() => Promise<void>> {
    return async () => {};
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

describe("RequestTransactionCategoryFromEmail", () => {
  it("sends a generated transaction category request from a matching email CSV attachment", async () => {
    const email = emailCommand({
      subject: "t x c a t",
      attachments: [csvAttachment([
        "Date,Payee,Outflow,Inflow",
        "2026-06-01,Grocery Store,₪42.00,₪0.00",
        "2026-06-02,Salary,₪0.00,\"₪5,000.00\"",
      ].join("\n"))],
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const request = new RequestTransactionCategoryFromEmail(inbox, whatsapp, {
      subjectPrefix: "TXCAT:",
      recipientPhoneNumber: "972501234567",
    });

    await new ProcessEmailAutomations(inbox, [request]).processUnread();

    expect(whatsapp.sent).toEqual([
      {
        phoneNumber: "972501234567",
        text: [
          "Hi, can you tell me what each of these transactions was for?",
          "",
          "1. 2026-06-01 - Grocery Store - ₪42.00",
          "2. 2026-06-02 - Salary - ₪5,000.00",
        ].join("\n"),
      },
    ]);
    expect(inbox.processed).toEqual([email]);
  });

  it("ignores emails without the configured subject prefix", async () => {
    const email = emailCommand({
      subject: "WA: normal command",
      attachments: [csvAttachment("Date,Payee,Outflow,Inflow\n")],
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const request = new RequestTransactionCategoryFromEmail(inbox, whatsapp, {
      subjectPrefix: "TXCAT:",
      recipientPhoneNumber: "972501234567",
    });

    await new ProcessEmailAutomations(inbox, [request]).processUnread();

    expect(whatsapp.sent).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });

  it("does not match longer words that start with the subject prefix", async () => {
    const email = emailCommand({
      subject: "TXCATALOG",
      attachments: [csvAttachment("Date,Payee,Outflow,Inflow\n")],
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const request = new RequestTransactionCategoryFromEmail(inbox, whatsapp, {
      subjectPrefix: "TXCAT:",
      recipientPhoneNumber: "972501234567",
    });

    await new ProcessEmailAutomations(inbox, [request]).processUnread();

    expect(whatsapp.sent).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });

  it("marks failed WhatsApp sends without blocking later emails", async () => {
    const failedEmail = emailCommand({
      id: "failed-email",
      subject: "TXCAT: request",
      attachments: [csvAttachment(
        "Date,Payee,Outflow,Inflow\n2026-06-01,Grocery Store,₪42.00,₪0.00",
      )],
    });
    const laterEmail = emailCommand({
      id: "later-email",
      subject: "TXCAT: request",
      attachments: [csvAttachment(
        "Date,Payee,Outflow,Inflow\n2026-06-02,Book Store,₪10.00,₪0.00",
      )],
    });
    const inbox = new FakeEmailInbox([failedEmail, laterEmail]);
    const whatsapp = new FakeWhatsAppSender();
    let attempts = 0;
    const request = new RequestTransactionCategoryFromEmail(inbox, {
      async sendMessage(message): Promise<SentMessage> {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("send failed");
        }
        whatsapp.sent.push(message);
        return { delivery: new Promise(() => {}) };
      },
      async sendImage(): Promise<SentMessage> {
        return { delivery: new Promise(() => {}) };
      },
    }, {
      subjectPrefix: "TXCAT:",
      recipientPhoneNumber: "972501234567",
    });

    await new ProcessEmailAutomations(inbox, [request]).processUnread();

    expect(inbox.processed).toEqual([laterEmail]);
    expect(inbox.failed).toEqual([failedEmail]);
    expect(whatsapp.sent).toHaveLength(1);
  });

  it("ignores matching emails without a CSV attachment", async () => {
    const email = emailCommand({
      subject: "TXCAT: request",
      attachments: [{
        filename: "notes.txt",
        contentType: "text/plain",
        content: Buffer.from("hello"),
      }],
    });
    const inbox = new FakeEmailInbox([email]);
    const whatsapp = new FakeWhatsAppSender();
    const request = new RequestTransactionCategoryFromEmail(inbox, whatsapp, {
      subjectPrefix: "TXCAT:",
      recipientPhoneNumber: "972501234567",
    });

    await new ProcessEmailAutomations(inbox, [request]).processUnread();

    expect(whatsapp.sent).toEqual([]);
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

function csvAttachment(content: string): MediaAttachment {
  return {
    filename: "transactions.csv",
    contentType: "text/csv",
    content: Buffer.from(content, "utf8"),
  };
}
