import type { InboundEmail } from "../domain/email.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailInbox } from "../ports/email-inbox.js";
import type { WhatsAppChatSender } from "../ports/whatsapp-sender.js";
import type {
  EmailAutomationBatch,
  EmailAutomationHandler,
} from "./process-email-automations.js";
import {
  replyTextFor,
  tokenFromMessageId,
  tokenFromSubject,
  type WhatsAppEmailThread,
  type WhatsAppEmailThreadStore,
} from "./whatsapp-email-thread-store.js";

const silentLogger: AppLogger = {
  info() {},
};

export type ReplyEmailToWhatsAppOptions = {
  ignoreFrom?: string;
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

    const thread = await this.threadFor(email);

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

    await this.whatsapp.sendChatMessage({
      chatId: thread.chatId,
      text,
    });
    await this.inbox.markProcessed(email);

    this.logger.info(
      `Forwarded reply email ${email.id} to WhatsApp chat ${thread.chatId}.`,
    );
    return true;
  }

  private isOwnForwardedEmail(email: InboundEmail): boolean {
    if (email.messageId?.includes("@message-automation-hub.local")) {
      return true;
    }

    return Boolean(
      this.options.ignoreFrom && email.from?.includes(this.options.ignoreFrom),
    );
  }

  private async threadFor(email: InboundEmail): Promise<WhatsAppEmailThread | null> {
    const subjectToken = tokenFromSubject(email.subject);

    if (subjectToken) {
      const thread = await this.threads.findByToken(subjectToken);

      if (thread) {
        return thread;
      }
    }

    for (const messageId of [email.inReplyTo, ...(email.references ?? [])]) {
      if (!messageId) {
        continue;
      }

      const token = tokenFromMessageId(messageId);
      const thread = token
        ? await this.threads.findByToken(token)
        : await this.threads.findByMessageId(messageId);

      if (thread) {
        return thread;
      }
    }

    return null;
  }
}
