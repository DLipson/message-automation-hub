import type { InboundEmail } from "../domain/email.js";
import { isImageAttachment, type MediaAttachment } from "../domain/media.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailInbox } from "../ports/email-inbox.js";
import type { WhatsAppSender } from "../ports/whatsapp-sender.js";

const silentLogger: AppLogger = {
  info() {},
};

const threeMinutesMs = 3 * 60 * 1000;
const fiveMinutesMs = 5 * 60 * 1000;

export type ForwardEmailToWhatsAppOptions = {
  subjectPrefix: string;
  imageDelayMs?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
};

type EmailCommand = {
  phoneNumber: string;
  text: string;
  image?: MediaAttachment;
  ignoredImageCount: number;
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
    let sentImage = false;

    for (const email of emails) {
      const command = this.parseCommand(email);

      if (!command) {
        continue;
      }

      if (command.image && sentImage) {
        await this.waitBeforeNextImage();
      }

      this.logger.info(
        `Detected command email ${email.id} with subject "${email.subject}".`,
      );

      if (command.image) {
        await this.forwardImageEmail(email, { ...command, image: command.image });
        sentImage = true;
      } else {
        await this.forwardTextEmail(email, command);
      }
    }
  }

  private async forwardTextEmail(
    email: InboundEmail,
    command: EmailCommand,
  ): Promise<void> {
    this.logger.info(
      `Forwarding email ${email.id} to WhatsApp number ${command.phoneNumber}.`,
    );

    await this.whatsapp.sendMessage({
      phoneNumber: command.phoneNumber,
      text: command.text,
    });
    await this.inbox.markProcessed(email);

    this.logger.info(
      `Forwarded email ${email.id} to WhatsApp number ${command.phoneNumber}.`,
    );
  }

  private async forwardImageEmail(
    email: InboundEmail,
    command: EmailCommand & { image: MediaAttachment },
  ): Promise<void> {
    this.logger.info(
      `Forwarding image email ${email.id} to WhatsApp number ${command.phoneNumber}.`,
    );

    if (command.ignoredImageCount > 0) {
      this.logger.info(
        `Email ${email.id} has ${command.ignoredImageCount} extra image attachment(s); sending the first image only.`,
      );
    }

    await this.whatsapp.sendImage({
      phoneNumber: command.phoneNumber,
      text: command.text,
      image: command.image,
    });
    await this.inbox.markProcessed(email);

    this.logger.info(
      `Forwarded image email ${email.id} to WhatsApp number ${command.phoneNumber}.`,
    );
  }

  private parseCommand(email: InboundEmail): EmailCommand | null {
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
    const images = (email.attachments ?? []).filter(isImageAttachment);
    const image = images[0];

    if (!phoneNumber || (!text && !image)) {
      return null;
    }

    return {
      phoneNumber,
      text,
      ...(image ? { image } : {}),
      ignoredImageCount: Math.max(0, images.length - 1),
    };
  }

  private async waitBeforeNextImage(): Promise<void> {
    const milliseconds = this.options.imageDelayMs?.() ?? randomDelayMs();
    await (this.options.wait ?? wait)(milliseconds);
  }
}

function normalizePhoneNumber(toLine: string): string {
  return toLine.replace(/^to:/i, "").replace(/\D/g, "");
}

function randomDelayMs(): number {
  return threeMinutesMs + Math.floor(Math.random() * (fiveMinutesMs - threeMinutesMs + 1));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}