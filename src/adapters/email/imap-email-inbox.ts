import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Attachment } from "mailparser";
import type { InboundEmail } from "../../domain/email.js";
import type { MediaAttachment } from "../../domain/media.js";
import type { EmailInbox } from "../../ports/email-inbox.js";

export type ImapEmailInboxConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
};

type FetchedEmail = InboundEmail & {
  uid: number;
};

export class ImapEmailInbox implements EmailInbox {
  private readonly config: ImapEmailInboxConfig;

  constructor(config: ImapEmailInboxConfig) {
    this.config = config;
  }

  async fetchUnread(): Promise<InboundEmail[]> {
    const client = this.createClient();

    await client.connect();

    try {
      await client.mailboxOpen("INBOX");

      const emails: FetchedEmail[] = [];

      for await (const message of client.fetch(
        { seen: false },
        { envelope: true, source: true, uid: true },
      )) {
        if (!message.source || !message.uid) {
          continue;
        }

        const parsed = await simpleParser(message.source);
        const attachments = parsed.attachments.map(toMediaAttachment);
        const references = referencesFor(parsed.references);

        const email: FetchedEmail = {
          id: String(message.uid),
          uid: message.uid,
          subject: parsed.subject ?? message.envelope?.subject ?? "",
          text: parsed.text ?? "",
          receivedAt: parsed.date ?? new Date(),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
          ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
          ...(references.length > 0 ? { references } : {}),
        };

        if (parsed.from?.text) {
          email.from = parsed.from.text;
        }

        emails.push(email);
      }

      return emails;
    } finally {
      await client.logout();
    }
  }

  async markProcessed(email: InboundEmail): Promise<void> {
    const uid = Number(email.id);

    if (!Number.isInteger(uid)) {
      throw new Error(`Cannot mark email without numeric IMAP uid: ${email.id}`);
    }

    const client = this.createClient();

    await client.connect();

    try {
      await client.mailboxOpen("INBOX");
      await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    } finally {
      await client.logout();
    }
  }

  private createClient(): ImapFlow {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: {
        user: this.config.user,
        pass: this.config.pass,
      },
      logger: false,
    });

    client.on("error", error => {
      console.error(`IMAP client error: ${formatError(error)}`);
    });

    return client;
  }
}

function toMediaAttachment(attachment: Attachment): MediaAttachment {
  return {
    content: attachment.content,
    contentType: attachment.contentType,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
  };
}

function referencesFor(references: string[] | string | undefined): string[] {
  if (!references) {
    return [];
  }

  return Array.isArray(references) ? references : [references];
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
