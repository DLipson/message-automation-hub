import { describe, expect, it } from "vitest";
import type { InboundEmail } from "../src/domain/email.js";
import type { MediaAttachment } from "../src/domain/media.js";
import type { EmailInbox } from "../src/ports/email-inbox.js";
import type {
  WhatsAppDirectImage,
  WhatsAppDirectMessage,
  WhatsAppSender,
} from "../src/ports/whatsapp-sender.js";
import {
  RequestTransactionCategoryFromEmail,
} from "../src/automations/transaction-category-request/request-from-email.js";

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
  readonly sentImages: WhatsAppDirectImage[] = [];

  async sendMessage(message: WhatsAppDirectMessage): Promise<void> {
    this.sent.push(message);
  }

  async sendImage(message: WhatsAppDirectImage): Promise<void> {
    this.sentImages.push(message);
  }
}

describe("RequestTransactionCategoryFromEmail", () => {
  it("sends a generated transaction category request from a matching email CSV attachment", async () => {
    const email = emailCommand({
      subject: "TXCAT: request categories",
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

    await request.processUnread();

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

    await request.processUnread();

    expect(whatsapp.sent).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });

  it("does not mark the email processed when WhatsApp sending fails", async () => {
    const email = emailCommand({
      subject: "TXCAT: request",
      attachments: [csvAttachment(
        "Date,Payee,Outflow,Inflow\n2026-06-01,Grocery Store,₪42.00,₪0.00",
      )],
    });
    const inbox = new FakeEmailInbox([email]);
    const request = new RequestTransactionCategoryFromEmail(inbox, {
      async sendMessage() {
        throw new Error("send failed");
      },
      async sendImage() {},
    }, {
      subjectPrefix: "TXCAT:",
      recipientPhoneNumber: "972501234567",
    });

    await expect(request.processUnread()).rejects.toThrow("send failed");

    expect(inbox.processed).toEqual([]);
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

    await request.processUnread();

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
