import type { InboundMessage } from "../domain/message.js";
import type { MediaAttachment } from "../domain/media.js";
import type { AppLogger } from "../ports/app-logger.js";
import { silentLogger } from "../ports/app-logger.js";
import type { EmailSender } from "../ports/email-sender.js";
import {
  forwardedMessageId,
  replyMarker,
  type WhatsAppEmailThreadStore,
} from "./whatsapp-email-thread-store.js";

const maxAttachments = 5;
const receivedAtFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

export type ForwardMessageToEmailOptions = {
  from: string;
  to: string;
  threadStore: WhatsAppEmailThreadStore;
  maxAttachmentSizeBytes?: number;
};

export class ForwardMessageToEmail {
  constructor(
    private readonly emailSender: EmailSender,
    private readonly options: ForwardMessageToEmailOptions,
    private readonly logger: AppLogger = silentLogger,
  ) {}

  async handle(message: InboundMessage): Promise<void> {
    const allAttachments = this.attachmentsFor(message);

    if (!message.text.trim() && allAttachments.length === 0) {
      return;
    }

    const sizeLimit = this.options.maxAttachmentSizeBytes;
    const accepted: MediaAttachment[] = [];
    const oversized: MediaAttachment[] = [];

    for (const attachment of allAttachments) {
      if (sizeLimit != null && attachment.content.length > sizeLimit) {
        oversized.push(attachment);
      } else {
        accepted.push(attachment);
      }
    }

    const capped = accepted.slice(0, maxAttachments);
    const omittedByCount = Math.max(0, accepted.length - maxAttachments);

    const sender = message.from.displayName ?? message.from.id;
    const contactLabel = this.senderLabelFor(message);
    const thread = await this.options.threadStore.getOrCreate(
      message.from.id,
      contactLabel,
    );

    this.logger.info(
      `Received WhatsApp message from ${sender}; forwarding to ${this.options.to}.`,
    );

    await this.emailSender.send({
      from: this.options.from,
      to: this.options.to,
      subject: thread.subject,
      text: this.bodyFor(message, oversized, omittedByCount),
      messageId: forwardedMessageId(thread, message.id),
      inReplyTo: thread.rootMessageId,
      references: [thread.rootMessageId],
      ...(capped.length > 0 ? { attachments: capped } : {}),
    });

    this.logger.info(
      `Forwarded WhatsApp message from ${sender} to ${this.options.to}.`,
    );
  }

  private bodyFor(
    message: InboundMessage,
    oversized: MediaAttachment[],
    omittedByCount: number,
  ): string {
    const lines = [
      message.text,
      "",
      `Received: ${receivedAtFormatter.format(message.receivedAt)} UTC`,
      "",
      replyMarker,
    ];

    for (const attachment of oversized) {
      const sizeMb = (attachment.content.length / (1024 * 1024)).toFixed(1);
      const limitMb = (this.options.maxAttachmentSizeBytes! / (1024 * 1024)).toFixed(1);
      const name = attachment.filename ?? "unnamed";
      lines.push(
        "",
        `Attachment not forwarded: ${name} (${sizeMb} MB) exceeds the ${limitMb} MB size limit.`,
      );
    }

    if (omittedByCount > 0) {
      lines.push(
        "",
        `Note: ${omittedByCount} additional attachment(s) were not forwarded because the per-message limit is ${maxAttachments}.`,
      );
    }

    return lines.join("\n");
  }

  private senderLabelFor(message: InboundMessage): string {
    const name = message.from.displayName ?? "Unknown";
    const identifier = message.from.id;
    const phoneNumber = identifier.endsWith("@c.us")
      ? identifier.slice(0, -"@c.us".length)
      : identifier;
    return `${name} - ${phoneNumber}`;
  }
  private attachmentsFor(message: InboundMessage): MediaAttachment[] {
    return message.attachments ?? [];
  }
}
