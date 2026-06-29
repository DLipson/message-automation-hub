import type { InboundEmail } from "../domain/email.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailInbox } from "../ports/email-inbox.js";
import type { WhatsAppSender } from "../ports/whatsapp-sender.js";

const silentLogger: AppLogger = {
  info() {},
};

export type ForwardEmailToWhatsAppOptions = {
  subjectPrefix: string;
};

export class ForwardEmailToWhatsApp {
  constructor(
    private readonly inbox: EmailInbox,
    private readonly whatsapp: WhatsAppSender,
    private readonly options: ForwardEmailToWhatsAppOptions,
    private readonly logger: AppLogger = silentLogger,
  ) {}

  async processUnread(): Promise<void> {
    const emails = await this.inbox.fetchUnread();

    for (const email of emails) {
      const command = this.parseCommand(email);

      if (!command) {
        continue;
      }

      this.logger.info(
        `Detected command email ${email.id} with subject "${email.subject}".`,
      );

      this.logger.info(
        `Forwarding email ${email.id} to WhatsApp number ${command.phoneNumber}.`,
      );

      await this.whatsapp.sendMessage(command);
      await this.inbox.markProcessed(email);

      this.logger.info(
        `Forwarded email ${email.id} to WhatsApp number ${command.phoneNumber}.`,
      );
    }
  }

  private parseCommand(
    email: InboundEmail,
  ): { phoneNumber: string; text: string } | null {
    if (!email.subject.trim().startsWith(this.options.subjectPrefix)) {
      return null;
    }

    const lines = email.text.split(/\r?\n/);
    const toLineIndex = lines.findIndex(line => /^to:/i.test(line.trim()));

    if (toLineIndex === -1) {
      return null;
    }

    const phoneNumber = normalizePhoneNumber(lines[toLineIndex] ?? "");
    const text = lines
      .slice(toLineIndex + 1)
      .join("\n")
      .trim();

    if (!phoneNumber || !text) {
      return null;
    }

    return { phoneNumber, text };
  }
}

function normalizePhoneNumber(toLine: string): string {
  return toLine.replace(/^to:/i, "").replace(/\D/g, "");
}
