import type { InboundEmail } from "../domain/email.js";

export type EmailInboxBatch = InboundEmail[] | {
  emails: InboundEmail[];
  complete(): Promise<void>;
};

export interface EmailInbox {
  fetchUnread(): Promise<EmailInboxBatch>;
  markProcessed(email: InboundEmail): Promise<void>;
  watchNewMail(onNewMail: () => void): Promise<() => Promise<void>>;
}

/**
 * Optional capability: mailboxes that support labels/folders for send feedback.
 * Gmail over IMAP does; a minimal EmailInbox need not. Workflows that depend on
 * it must declare it so registration fails fast instead of at first call.
 */
export interface EmailLabeler {
  ensureLabels(labels: string[]): Promise<void>;
}

export interface EmailStatusMarker {
  markSent(email: InboundEmail): Promise<void>;
  markDelivered(email: InboundEmail): Promise<void>;
  markFailed(email: InboundEmail): Promise<void>;
}
