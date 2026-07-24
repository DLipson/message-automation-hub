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

export interface EmailStatusMarker {
  markSent(email: InboundEmail): Promise<void>;
  markDelivered(email: InboundEmail): Promise<void>;
  markFailed(email: InboundEmail): Promise<void>;
}
