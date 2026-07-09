import type { InboundMessage } from "../domain/message.js";
import { isImageAttachment, type MediaAttachment } from "../domain/media.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailSender } from "../ports/email-sender.js";
import {
  forwardedMessageId,
  replyMarker,
  type WhatsAppEmailThread,
  type WhatsAppEmailThreadStore,
} from "./whatsapp-email-thread-store.js";

const silentLogger: AppLogger = {
  info() {},
};

const maxImageAttachments = 5;

export type ForwardMessageToEmailOptions = {
  from: string;
  to: string;
  threadStore?: WhatsAppEmailThreadStore;
};

export class ForwardMessageToEmail {
  constructor(
    private readonly emailSender: EmailSender,
    private readonly options: ForwardMessageToEmailOptions,
    private readonly logger: AppLogger = silentLogger,
  ) {}

  async handle(message: InboundMessage): Promise<void> {
    const imageAttachments = this.imageAttachmentsFor(message);

    if (!message.text.trim() && imageAttachments.length === 0) {
      return;
    }

    const sender = message.from.displayName ?? message.from.id;
    const thread = this.options.threadStore
      ? await this.options.threadStore.getOrCreate(message.from.id, sender)
      : null;

    this.logger.info(
      `Received WhatsApp message from ${sender}; forwarding to ${this.options.to}.`,
    );

    await this.emailSender.send({
      from: this.options.from,
      to: this.options.to,
      subject: thread?.subject ?? this.subjectFor(message),
      text: this.bodyFor(message, thread),
      ...(thread ? {
        messageId: forwardedMessageId(thread, message.id),
        inReplyTo: thread.rootMessageId,
        references: [thread.rootMessageId],
      } : {}),
      ...(imageAttachments.length > 0 ? { attachments: imageAttachments.slice(0, maxImageAttachments) } : {}),
    });

    this.logger.info(
      `Forwarded WhatsApp message from ${sender} to ${this.options.to}.`,
    );
  }

  private subjectFor(message: InboundMessage): string {
    const sender = message.from.displayName ?? message.from.id;
    return `WhatsApp message from ${sender}`;
  }

  private bodyFor(
    message: InboundMessage,
    thread: WhatsAppEmailThread | null,
  ): string {
    const sender = message.from.displayName
      ? `${message.from.displayName} (${message.from.id})`
      : message.from.id;
    const imageCount = this.imageAttachmentsFor(message).length;
    const omittedImageCount = Math.max(0, imageCount - maxImageAttachments);
    const lines = thread
      ? [
        `${message.from.displayName ?? message.from.id}:`,
        "",
        message.text,
        "",
        replyMarker,
        "",
        `From: ${sender}`,
        `Received: ${message.receivedAt.toISOString()}`,
      ]
      : [
        `From: ${sender}`,
        `Received: ${message.receivedAt.toISOString()}`,
        "",
        message.text,
      ];

    if (omittedImageCount > 0) {
      lines.push(
        "",
        `Note: ${omittedImageCount} additional image attachment(s) were not forwarded because the per-message limit is ${maxImageAttachments}.`,
      );
    }

    return lines.join("\n");
  }

  private imageAttachmentsFor(message: InboundMessage): MediaAttachment[] {
    return (message.attachments ?? []).filter(isImageAttachment);
  }
}
