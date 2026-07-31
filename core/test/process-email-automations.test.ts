import { describe, expect, it } from "vitest";
import type { InboundEmail } from "../src/domain/email.js";
import { createPluginContext } from "../src/core/plugin-runtime.js";
import type {
  EmailAutomationBatch,
  EmailAutomationHandler,
} from "../src/use-cases/process-email-automations.js";
import { FakeEmailInbox } from "./fakes/fake-email-inbox.js";
import { ProcessEmailAutomations } from "../src/use-cases/process-email-automations.js";

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
    const ctx = createPluginContext();
    const first = new RecordingHandler(false);
    const second = new RecordingHandler(true);
    const third = new RecordingHandler(true);

    ctx.on("email.received", ({ email: e, batch }) => first.handle(e, batch));
    ctx.on("email.received", ({ email: e, batch }) => second.handle(e, batch));
    ctx.on("email.received", ({ email: e, batch }) => third.handle(e, batch));

    const processor = new ProcessEmailAutomations(inbox, ctx);

    await processor.processUnread();

    expect(first.received).toEqual([email]);
    expect(second.received).toEqual([email]);
    expect(third.received).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });

  it("marks a failed email and continues with later emails", async () => {
    const failedEmail = emailCommand({ id: "failed" });
    const laterEmail = emailCommand({ id: "later" });
    const inbox = new FakeEmailInbox([failedEmail, laterEmail]);
    const ctx = createPluginContext();
    const handled: InboundEmail[] = [];

    ctx.on("email.received", async ({ email: e }) => {
      if (e.id === "failed") {
        throw new Error("send failed");
      }

      handled.push(e);
      return true;
    });

    await new ProcessEmailAutomations(inbox, ctx).processUnread();

    expect(inbox.failed).toEqual([failedEmail]);
    expect(handled).toEqual([laterEmail]);
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
