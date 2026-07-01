import { describe, expect, it } from "vitest";
import type { InboundEmail } from "../src/domain/email.js";
import type { EmailInbox } from "../src/ports/email-inbox.js";
import type {
  EmailAutomationBatch,
  EmailAutomationHandler,
} from "../src/use-cases/process-email-automations.js";
import { ProcessEmailAutomations } from "../src/use-cases/process-email-automations.js";

class FakeEmailInbox implements EmailInbox {
  readonly processed: InboundEmail[] = [];

  constructor(private readonly emails: InboundEmail[]) {}

  async fetchUnread(): Promise<InboundEmail[]> {
    return this.emails;
  }

  async markProcessed(email: InboundEmail): Promise<void> {
    this.processed.push(email);
  }
}

class RecordingHandler implements EmailAutomationHandler {
  readonly received: InboundEmail[] = [];

  constructor(private readonly shouldHandle: boolean) {}

  async handle(
    email: InboundEmail,
    _batch: EmailAutomationBatch,
  ): Promise<boolean> {
    this.received.push(email);
    return this.shouldHandle;
  }
}

describe("ProcessEmailAutomations", () => {
  it("passes unread emails to handlers until one handles the email", async () => {
    const email = emailCommand({ subject: "TXCAT: request" });
    const inbox = new FakeEmailInbox([email]);
    const first = new RecordingHandler(false);
    const second = new RecordingHandler(true);
    const third = new RecordingHandler(true);
    const processor = new ProcessEmailAutomations(inbox, [
      first,
      second,
      third,
    ]);

    await processor.processUnread();

    expect(first.received).toEqual([email]);
    expect(second.received).toEqual([email]);
    expect(third.received).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });
});

function emailCommand(overrides: Partial<InboundEmail>): InboundEmail {
  return {
    id: "email-1",
    subject: "",
    text: "",
    receivedAt: new Date("2026-06-21T08:00:00.000Z"),
    ...overrides,
  };
}
