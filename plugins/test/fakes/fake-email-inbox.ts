import type { InboundEmail } from "@message-automation/core/api/index.js";
import type { EmailInbox, EmailStatusMarker } from "@message-automation/core/api/index.js";

export class FakeEmailInbox implements EmailInbox, EmailStatusMarker {
  readonly processed: InboundEmail[] = [];
  readonly failed: InboundEmail[] = [];
  readonly sent: InboundEmail[] = [];
  readonly delivered: InboundEmail[] = [];

  constructor(private readonly emails: InboundEmail[] = []) {}

  async fetchUnread(): Promise<InboundEmail[]> {
    return this.emails;
  }

  async markProcessed(email: InboundEmail): Promise<void> {
    this.processed.push(email);
  }

  async markSent(email: InboundEmail): Promise<void> {
    this.sent.push(email);
  }

  async markDelivered(email: InboundEmail): Promise<void> {
    this.delivered.push(email);
  }

  async markFailed(email: InboundEmail): Promise<void> {
    this.failed.push(email);
  }

  async watchNewMail(): Promise<() => Promise<void>> {
    return async () => {};
  }
}
