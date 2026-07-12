import type { InboundMessage } from "../domain/message.js";
import type { MediaAttachment } from "../domain/media.js";
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

const maxAttachments = 5;

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
    const attachments = this.attachmentsFor(message);

    if (!message.text.trim() && attachments.length === 0) {
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
      ...(attachments.length > 0 ? { attachments: attachments.slice(0, maxAttachments) } : {}),
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
    const attachmentCount = this.attachmentsFor(message).length;
    const omittedAttachmentCount = Math.max(0, attachmentCount - maxAttachments);
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

    if (omittedAttachmentCount > 0) {
      lines.push(
        "",
        `Note: ${omittedAttachmentCount} additional attachment(s) were not forwarded because the per-message limit is ${maxAttachments}.`,
      );
    }

    return lines.join("\n");
  }

  private attachmentsFor(message: InboundMessage): MediaAttachment[] {
    return message.attachments ?? [];
  }
}
