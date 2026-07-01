import type { InboundMessage } from "../domain/message.js";
import { isImageAttachment, type MediaAttachment } from "../domain/media.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailSender } from "../ports/email-sender.js";

const silentLogger: AppLogger = {
  info() {},
};

const maxImageAttachments = 5;

export class ForwardMessageToEmail {
  constructor(
    private readonly emailSender: EmailSender,
    private readonly options: { from: string; to: string },
    private readonly logger: AppLogger = silentLogger,
  ) {}

  async handle(message: InboundMessage): Promise<void> {
    const imageAttachments = this.imageAttachmentsFor(message);

    if (!message.text.trim() && imageAttachments.length === 0) {
      return;
    }

    const sender = message.from.displayName ?? message.from.id;
    this.logger.info(
      `Received WhatsApp message from ${sender}; forwarding to ${this.options.to}.`,
    );

    await this.emailSender.send({
      from: this.options.from,
      to: this.options.to,
      subject: this.subjectFor(message),
      text: this.bodyFor(message),
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

  private bodyFor(message: InboundMessage): string {
    const sender = message.from.displayName
      ? `${message.from.displayName} (${message.from.id})`
      : message.from.id;
    const imageCount = this.imageAttachmentsFor(message).length;
    const omittedImageCount = Math.max(0, imageCount - maxImageAttachments);
    const lines = [
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