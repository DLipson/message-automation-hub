import type { InboundEmail } from "../domain/email.js";
import type { EmailInbox, EmailStatusMarker } from "../ports/email-inbox.js";

export type EmailAutomationBatch = {
  sentWhatsAppImage: boolean;
};

export interface EmailAutomationHandler {
  handle(email: InboundEmail, batch: EmailAutomationBatch): Promise<boolean>;
}

export function parseSubjectCommand(subject: string, prefix: string): string | null {
  const trimmedPrefix = prefix.trim();
  const hasOptionalColon = trimmedPrefix.endsWith(":");
  const requiredPrefix = hasOptionalColon ? trimmedPrefix.slice(0, -1) : trimmedPrefix;
  let subjectIndex = 0;

  for (const prefixCharacter of requiredPrefix) {
    if (isIgnoredSubjectSeparator(prefixCharacter)) {
      continue;
    }

    while (
      subjectIndex < subject.length &&
      isIgnoredSubjectSeparator(subject[subjectIndex] ?? "")
    ) {
      subjectIndex += 1;
    }

    if (
      subjectIndex >= subject.length ||
      subject[subjectIndex]?.toLowerCase() !== prefixCharacter.toLowerCase()
    ) {
      return null;
    }

    subjectIndex += 1;
  }

  const matchedPrefixEnd = subjectIndex;
  while (
    subjectIndex < subject.length &&
    isIgnoredSubjectSeparator(subject[subjectIndex] ?? "")
  ) {
    subjectIndex += 1;
  }

  if (hasOptionalColon && subject[subjectIndex] === ":") {
    subjectIndex += 1;
  } else if (matchedPrefixEnd === subjectIndex && /^[a-z]$/i.test(subject[subjectIndex] ?? "")) {
    return null;
  }

  while (
    subjectIndex < subject.length &&
    isIgnoredSubjectSeparator(subject[subjectIndex] ?? "")
  ) {
    subjectIndex += 1;
  }

  return subject.slice(subjectIndex).trim();
}

export class ProcessEmailAutomations {
  constructor(
    private readonly inbox: EmailInbox,
    private readonly handlers: EmailAutomationHandler[],
  ) {}

  async processUnread(): Promise<void> {
    const fetched = await this.inbox.fetchUnread();
    const emails = Array.isArray(fetched) ? fetched : fetched.emails;
    const batch: EmailAutomationBatch = { sentWhatsAppImage: false };

    for (const email of emails) {
      try {
        for (const handler of this.handlers) {
          if (await handler.handle(email, batch)) {
            break;
          }
        }
      } catch (error) {
        console.error("Email automation failed for email " + email.id + ": " + formatError(error));
        await this.markFailed(email);
      }
    }

    if (!Array.isArray(fetched)) {
      await fetched.complete();
    }
  }

  private async markFailed(email: InboundEmail): Promise<void> {
    if (!isEmailStatusMarker(this.inbox)) {
      return;
    }

    try {
      await this.inbox.markFailed(email);
    } catch (error) {
      console.error("Could not mark failed email " + email.id + ": " + formatError(error));
    }
  }
}

function isIgnoredSubjectSeparator(character: string): boolean {
  return /\s|-/.test(character);
}

function isEmailStatusMarker(inbox: EmailInbox): inbox is EmailInbox & EmailStatusMarker {
  return "markFailed" in inbox && typeof inbox.markFailed === "function";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
