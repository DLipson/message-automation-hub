import type { InboundEmail } from "../domain/email.js";

export interface EmailInbox {
  fetchUnread(): Promise<InboundEmail[]>;
  markProcessed(email: InboundEmail): Promise<void>;
}
