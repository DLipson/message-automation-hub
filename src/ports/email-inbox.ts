import type { InboundEmail } from "../domain/email.js";

export interface EmailInbox {
  fetchUnread(): Promise<InboundEmail[]>;
  markProcessed(email: InboundEmail): Promise<void>;
}

export interface EmailStatusMarker {
  markSent(email: InboundEmail): Promise<void>;
  markFailed(email: InboundEmail): Promise<void>;
}
