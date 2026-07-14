import type { InboundEmail } from "../domain/email.js";
import { isImageAttachment, type MediaAttachment } from "../domain/media.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailInbox, EmailStatusMarker } from "../ports/email-inbox.js";
import type { EmailSender } from "../ports/email-sender.js";
import type { WhatsAppSender } from "../ports/whatsapp-sender.js";
import type {
  EmailAutomationBatch,
  EmailAutomationHandler,
} from "./process-email-automations.js";
import { parseSubjectCommand } from "./process-email-automations.js";

const silentLogger: AppLogger = {
  info() {},
};

const threeMinutesMs = 3 * 60 * 1000;
const fiveMinutesMs = 5 * 60 * 1000;
const minimumPhoneNumberDigits = 7;

export type ForwardEmailToWhatsAppOptions = {
  subjectPrefix: string;
  imageDelayMs?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  extraImageNotification?: {
    sender: EmailSender;
    from: string;
  };
  failureNotification?: {
    sender: EmailSender;
    from: string;
    to: string;
  };
};

type EmailCommand = {
  phoneNumber: string;
  text: string;
  image?: MediaAttachment;
  ignoredImageCount: number;
};

export class ForwardEmailToWhatsApp implements EmailAutomationHandler {
  constructor(
    private readonly inbox: EmailInbox & EmailStatusMarker,
    private readonly whatsapp: WhatsAppSender,
    private readonly options: ForwardEmailToWhatsAppOptions,
    private readonly logger: AppLogger = silentLogger,
  ) {}


  async handle(
    email: InboundEmail,
    batch: EmailAutomationBatch,
  ): Promise<boolean> {
    const command = this.parseCommand(email);

    if (!command) {
      return false;
    }

    this.logger.info(
      `Detected command email ${email.id} with subject "${email.subject}".`,
    );
    await this.inbox.markProcessed(email);

    if (command.image && batch.sentWhatsAppImage) {
      await this.waitBeforeNextImage();
    }

    try {
      if (command.image) {
        await this.forwardImageEmail(email, { ...command, image: command.image });
        batch.sentWhatsAppImage = true;
      } else {
        await this.forwardTextEmail(email, command);
      }

      await this.inbox.markSent(email);
      return true;
    } catch (error) {
      await this.markFailedAndNotify(email, command, error);
      return true;
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
    await this.notifyExtraImagesIgnored(email, command);

    this.logger.info(
      `Forwarded image email ${email.id} to WhatsApp number ${command.phoneNumber}.`,
    );
  }

  private async markFailedAndNotify(
    email: InboundEmail,
    command: EmailCommand,
    error: unknown,
  ): Promise<void> {
    await this.inbox.markFailed(email);

    try {
      await this.notifySendFailure(email, command, error);
    } catch (notificationError) {
      this.logger.info(
        `Could not send WhatsApp failure notice for email ${email.id}: ${
          notificationError instanceof Error ? notificationError.message : "Unknown error"
        }`,
      );
    }
  }

  private async notifySendFailure(
    email: InboundEmail,
    command: EmailCommand,
    error: unknown,
  ): Promise<void> {
    const notification = this.options.failureNotification;

    if (!notification) {
      return;
    }

    await notification.sender.send({
      from: notification.from,
      to: notification.to,
      subject: `WA send failed: ${command.phoneNumber}`,
      text: [
        "Message Automation Hub could not send a WhatsApp command email.",
        "",
        `Target: ${command.phoneNumber}`,
        `Email subject: ${email.subject}`,
        `Email id: ${email.id}`,
        `Time: ${email.receivedAt.toISOString()}`,
        "",
        "Message:",
        command.text,
        "",
        "Error:",
        formatError(error),
      ].join("\n"),
    });
  }

  private async notifyExtraImagesIgnored(
    email: InboundEmail,
    command: EmailCommand,
  ): Promise<void> {
    if (command.ignoredImageCount === 0) {
      return;
    }

    if (!this.options.extraImageNotification || !email.from) {
      return;
    }

    try {
      await this.options.extraImageNotification.sender.send({
        from: this.options.extraImageNotification.from,
        to: email.from,
        subject: "Only one image was sent to WhatsApp",
        text: [
          `Your email "${email.subject}" had ${command.ignoredImageCount + 1} image attachments.`,
          "",
          "Message Automation Hub sent the first image to WhatsApp and skipped the remaining image attachment(s).",
        ].join("\n"),
      });
      this.logger.info(
        `Sent extra-image notice for email ${email.id} to ${email.from}.`,
      );
    } catch (error) {
      this.logger.info(
        `Could not send extra-image notice for email ${email.id}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  private parseCommand(email: InboundEmail): EmailCommand | null {
    const rawPhoneNumber = parseSubjectCommand(
      email.subject,
      this.options.subjectPrefix,
    );

    if (rawPhoneNumber === null) {
      return null;
    }

    if (!isValidPhoneNumber(rawPhoneNumber)) {
      return null;
    }

    const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
    const text = email.text.trim();
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

function isValidPhoneNumber(phoneNumber: string): boolean {
  return (
    !/\p{L}/u.test(phoneNumber) &&
    normalizePhoneNumber(phoneNumber).length >= minimumPhoneNumberDigits
  );
}

function normalizePhoneNumber(phoneNumber: string): string {
  return phoneNumber.replace(/\D/g, "");
}

function randomDelayMs(): number {
  return threeMinutesMs + Math.floor(Math.random() * (fiveMinutesMs - threeMinutesMs + 1));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.toString();
  }

  return String(error);
}
