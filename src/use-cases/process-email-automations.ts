import type { InboundEmail } from "../domain/email.js";
import type { EmailInbox } from "../ports/email-inbox.js";

export type EmailAutomationBatch = {
  sentWhatsAppImage: boolean;
};

export interface EmailAutomationHandler {
  handle(email: InboundEmail, batch: EmailAutomationBatch): Promise<boolean>;
}

export class ProcessEmailAutomations {
  constructor(
    private readonly inbox: EmailInbox,
    private readonly handlers: EmailAutomationHandler[],
  ) {}

  async processUnread(): Promise<void> {
    const emails = await this.inbox.fetchUnread();
    const batch: EmailAutomationBatch = { sentWhatsAppImage: false };

    for (const email of emails) {
      for (const handler of this.handlers) {
        if (await handler.handle(email, batch)) {
          break;
        }
      }
    }
  }
}
