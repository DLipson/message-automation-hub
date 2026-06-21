import type { InboundMessage } from "../domain/message.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailSender } from "../ports/email-sender.js";

const silentLogger: AppLogger = {
  info() {},
};

export class ForwardMessageToEmail {
  constructor(
    private readonly emailSender: EmailSender,
    private readonly options: { from: string; to: string },
    private readonly logger: AppLogger = silentLogger,
  ) {}

  async handle(message: InboundMessage): Promise<void> {
    if (!message.text.trim()) {
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

    return [
      `From: ${sender}`,
      `Received: ${message.receivedAt.toISOString()}`,
      "",
      message.text,
    ].join("\n");
  }
}
