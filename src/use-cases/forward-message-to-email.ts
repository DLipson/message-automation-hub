import type { InboundMessage } from "../domain/message.js";
import type { EmailSender } from "../ports/email-sender.js";

export class ForwardMessageToEmail {
  constructor(
    private readonly emailSender: EmailSender,
    private readonly options: { from: string; to: string },
  ) {}

  async handle(message: InboundMessage): Promise<void> {
    if (!message.text.trim()) {
      return;
    }

    await this.emailSender.send({
      from: this.options.from,
      to: this.options.to,
      subject: this.subjectFor(message),
      text: this.bodyFor(message),
    });
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
