import type { InboundEmail } from "../../domain/email.js";
import type { MediaAttachment } from "../../domain/media.js";
import type { AppLogger } from "../../ports/app-logger.js";
import type { EmailInbox } from "../../ports/email-inbox.js";
import type { WhatsAppSender } from "../../ports/whatsapp-sender.js";
import type {
  EmailAutomationBatch,
  EmailAutomationHandler,
} from "../../use-cases/process-email-automations.js";
import { parseSubjectCommand } from "../../use-cases/process-email-automations.js";
import { buildTransactionCategoryRequestMessage } from "./message-builder.js";

const silentLogger: AppLogger = {
  info() {},
};

export type RequestTransactionCategoryFromEmailOptions = {
  subjectPrefix: string;
  recipientPhoneNumber: string;
};

export class RequestTransactionCategoryFromEmail implements EmailAutomationHandler {
  constructor(
    private readonly inbox: EmailInbox,
    private readonly whatsapp: WhatsAppSender,
    private readonly options: RequestTransactionCategoryFromEmailOptions,
    private readonly logger: AppLogger = silentLogger,
  ) {}

  async processUnread(): Promise<void> {
    const emails = await this.inbox.fetchUnread();
    const batch: EmailAutomationBatch = { sentWhatsAppImage: false };

    for (const email of emails) {
      await this.handle(email, batch);
    }
  }

  async handle(
    email: InboundEmail,
    _batch: EmailAutomationBatch,
  ): Promise<boolean> {
    if (parseSubjectCommand(email.subject, this.options.subjectPrefix) === null) {
      return false;
    }

    const attachment = csvAttachmentFor(email);

    if (!attachment) {
      this.logger.info(
        `Transaction category request email ${email.id} has no CSV attachment.`,
      );
      return false;
    }

    const text = buildTransactionCategoryRequestMessage(
      attachment.content.toString("utf8"),
    );

    this.logger.info(
      `Sending transaction category request from email ${email.id} to WhatsApp number ${this.options.recipientPhoneNumber}.`,
    );

    await this.whatsapp.sendMessage({
      phoneNumber: this.options.recipientPhoneNumber,
      text,
    });
    await this.inbox.markProcessed(email);

    this.logger.info(
      `Sent transaction category request from email ${email.id} to WhatsApp number ${this.options.recipientPhoneNumber}.`,
    );

    return true;
  }
}

function csvAttachmentFor(email: InboundEmail): MediaAttachment | null {
  return (email.attachments ?? []).find(isCsvAttachment) ?? null;
}

function isCsvAttachment(attachment: MediaAttachment): boolean {
  const contentType = attachment.contentType.toLowerCase();
  const filename = attachment.filename?.toLowerCase() ?? "";

  return (
    contentType === "text/csv" ||
    contentType === "application/csv" ||
    contentType === "application/vnd.ms-excel" ||
    filename.endsWith(".csv")
  );
}
