import { randomBytes } from "node:crypto";
import { appDefaults } from "../config.js";
import type { InboundEmail } from "../domain/email.js";
import { formatError } from "../errors.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailInbox } from "../ports/email-inbox.js";
import type { EmailSender } from "../ports/email-sender.js";
import type { WhatsAppChatSender } from "../ports/whatsapp-sender.js";
import type { PendingGroupInviteStore } from "./pending-group-invite-store.js";
import type { EmailAutomationHandler } from "./process-email-automations.js";
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

const inviteLinkPattern = /https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/;

export type AcceptGroupInviteByEmailOptions = {
  ownerEmail: string;
  from: string;
  messageIdDomain?: string;
};

export class AcceptGroupInviteByEmail implements EmailAutomationHandler {
  constructor(
    private readonly inbox: EmailInbox,
    private readonly emailSender: EmailSender,
    private readonly threads: WhatsAppEmailThreadStore,
    private readonly pending: PendingGroupInviteStore,
    private readonly whatsapp: WhatsAppChatSender,
    private readonly options: AcceptGroupInviteByEmailOptions,
    private readonly logger: AppLogger = silentLogger,
  ) {}

  async handle(email: InboundEmail, _batch: unknown): Promise<boolean> {
    const pendingToken = await this.pendingTokenFor(email);

    if (pendingToken) {
      const pendingInvite = await this.pending.findByToken(pendingToken);
      if (pendingInvite) {
        await this.handleReply(email, pendingToken, pendingInvite.inviteCode);
        return true;
      }
    }

    const inviteCode = inviteCodeFrom(email);

    if (inviteCode) {
      await this.recordInvite(email, inviteCode);
      return true;
    }

    return false;
  }

  private async handleReply(
    email: InboundEmail,
    token: string,
    inviteCode: string,
  ): Promise<void> {
    if (!this.isOwner(email)) {
      await this.inbox.markProcessed(email);
      return;
    }

    if (/^accept$/i.test(replyTextFor(email.text).trim())) {
      await this.accept(email, token, inviteCode);
    } else {
      await this.nudge(email, token, inviteCode);
    }
  }

  private async accept(
    email: InboundEmail,
    token: string,
    inviteCode: string,
  ): Promise<void> {
    try {
      const chatId = await this.whatsapp.acceptInvite(inviteCode);
      await this.pending.remove(token);
      await this.sendEmail(`Group invite accepted [wa:${token}]`, [
        "The WhatsApp group invite was accepted.",
        "",
        `Group chat id: ${chatId}`,
      ]);
      this.logger.info(`Accepted group invite ${token} as chat ${chatId}.`);
    } catch (error) {
      await this.sendEmail(`Group invite could not be accepted [wa:${token}]`, [
        "The WhatsApp group invite could not be accepted.",
        "",
        `Error: ${formatError(error)}`,
        "",
        "Reply with exactly: accept",
        "",
        `Invite link: https://chat.whatsapp.com/${inviteCode}`,
      ]);
      this.logger.info(`Failed to accept group invite ${token}: ${formatError(error)}`);
    }

    await this.inbox.markProcessed(email);
  }

  private async nudge(
    email: InboundEmail,
    token: string,
    inviteCode: string,
  ): Promise<void> {
    await this.sendEmail(`Group invite pending [wa:${token}]`, [
      "This email is a reply to a pending WhatsApp group invite.",
      "",
      "Reply with exactly: accept",
      "",
      `Invite link: https://chat.whatsapp.com/${inviteCode}`,
    ]);
    await this.inbox.markProcessed(email);
  }

  private async recordInvite(
    email: InboundEmail,
    inviteCode: string,
  ): Promise<void> {
    const thread = await this.threadFor(email);
    const token = thread?.token ?? this.newToken();
    await this.pending.put(token, inviteCode);

    const rootMessageId = thread?.rootMessageId ?? this.rootMessageIdFor(token);
    await this.sendEmail(`Group invite detected [wa:${token}]`, [
      "A WhatsApp group invite was received.",
      "",
      "Reply with exactly: accept",
      "",
      `Invite link: https://chat.whatsapp.com/${inviteCode}`,
    ], rootMessageId);
    await this.inbox.markProcessed(email);
    this.logger.info(`Recorded pending group invite ${token}.`);
  }

  private async sendEmail(
    subject: string,
    bodyLines: string[],
    rootMessageId?: string,
  ): Promise<void> {
    await this.emailSender.send({
      from: this.options.from,
      to: this.options.ownerEmail,
      subject,
      text: bodyLines.join("\n"),
      ...(rootMessageId
        ? { messageId: rootMessageId, inReplyTo: rootMessageId, references: [rootMessageId] }
        : {}),
    });
  }

  private async pendingTokenFor(email: InboundEmail): Promise<string | null> {
    const subjectToken = tokenFromSubject(email.subject);

    if (subjectToken && await this.pending.findByToken(subjectToken)) {
      return subjectToken;
    }

    for (const messageId of [email.inReplyTo, ...(email.references ?? [])]) {
      if (!messageId) {
        continue;
      }

      const token = tokenFromMessageId(messageId);

      if (token && await this.pending.findByToken(token)) {
        return token;
      }
    }

    return null;
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

  private isOwner(email: InboundEmail): boolean {
    return Boolean(email.from?.includes(this.options.ownerEmail));
  }

  private newToken(): string {
    return randomBytes(6).toString("base64url");
  }

  private rootMessageIdFor(token: string): string {
    return `<wa.${token}@${this.options.messageIdDomain ?? appDefaults.emailMessageIdDomain}>`;
  }
}

function inviteCodeFrom(email: InboundEmail): string | null {
  const match = inviteLinkPattern.exec(email.text) ?? inviteLinkPattern.exec(email.subject);
  return match?.[1] ?? null;
}
