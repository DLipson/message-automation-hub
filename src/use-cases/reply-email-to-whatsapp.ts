import type { InboundEmail } from "../domain/email.js";
import { formatError } from "../errors.js";
import type { AppLogger } from "../ports/app-logger.js";
import { silentLogger } from "../ports/app-logger.js";
import type { EmailInbox } from "../ports/email-inbox.js";
import type { EmailSender } from "../ports/email-sender.js";
import type { WhatsAppChatSender } from "../ports/whatsapp-sender.js";
import type {
  EmailAutomationBatch,
  EmailAutomationHandler,
} from "./process-email-automations.js";
import {
  replyTextFor,
  threadForEmail,
  type WhatsAppEmailThread,
  type WhatsAppEmailThreadStore,
} from "./whatsapp-email-thread-store.js";

export type ReplyEmailToWhatsAppOptions = {
  failureNotification?: {
    sender: EmailSender;
    from: string;
    to: string;
  };
};

export class ReplyEmailToWhatsApp implements EmailAutomationHandler {
  constructor(
    private readonly inbox: EmailInbox,
    private readonly whatsapp: WhatsAppChatSender,
    private readonly threads: WhatsAppEmailThreadStore,
    private readonly logger: AppLogger = silentLogger,
    private readonly options: ReplyEmailToWhatsAppOptions = {},
  ) {}

  async handle(
    email: InboundEmail,
    _batch: EmailAutomationBatch,
  ): Promise<boolean> {
    if (this.isOwnForwardedEmail(email)) {
      return false;
    }

    const thread = await threadForEmail(this.threads, email);

    if (!thread) {
      return false;
    }

    const text = replyTextFor(email.text);

    if (!text) {
      await this.inbox.markProcessed(email);
      this.logger.info(`Ignored empty WhatsApp thread reply email ${email.id}.`);
      return true;
    }

    this.logger.info(
      `Forwarding reply email ${email.id} to WhatsApp chat ${thread.chatId}.`,
    );

    try {
      const sentMsg = await this.whatsapp.sendChatMessage({
        chatId: thread.chatId,
        text,
      });

      sentMsg.delivery.then(async status => {
        if (status === "error") {
          await this.notifyFailure(email, thread);
        }
      }).catch(() => {});
    } catch (error) {
      await this.notifyFailure(email, thread);
      this.logger.info(
        `Failed to forward reply email ${email.id} to WhatsApp chat ${thread.chatId}: ${formatError(error)}`,
      );
      return true;
    }

    await this.inbox.markProcessed(email);

    this.logger.info(
      `Forwarded reply email ${email.id} to WhatsApp chat ${thread.chatId}.`,
    );
    return true;
  }

  private isOwnForwardedEmail(email: InboundEmail): boolean {
    return Boolean(
      email.messageId?.includes("@message-automation-hub.local"),
    );
  }

  private async notifyFailure(
    email: InboundEmail,
    thread: WhatsAppEmailThread,
  ): Promise<void> {
    const notification = this.options.failureNotification;

    if (!notification) {
      return;
    }

    try {
      await notification.sender.send({
        from: notification.from,
        to: notification.to,
        subject: `WA reply failed: ${thread.chatId}`,
        text: [
          "Message Automation Hub could not send a WhatsApp reply.",
          "",
          `Chat: ${thread.chatId}`,
          `Thread token: ${thread.token}`,
          `Email subject: ${email.subject}`,
          `Email id: ${email.id}`,
          `Time: ${email.receivedAt.toISOString()}`,
          "",
          "Message:",
          replyTextFor(email.text),
        ].join("\n"),
      });
    } catch (notificationError) {
      this.logger.info(
        `Could not send reply failure notice for email ${email.id}: ${formatError(notificationError)}`,
      );
    }
  }
}
