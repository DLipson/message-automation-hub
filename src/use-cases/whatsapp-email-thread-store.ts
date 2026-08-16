import { appDefaults } from "../config.js";
import type { InboundEmail } from "../domain/email.js";

export const replyMarker = "--- Reply above this line ---";

export type WhatsAppEmailThread = {
  token: string;
  chatId: string;
  subject: string;
  rootMessageId: string;
};

export interface WhatsAppEmailThreadStore {
  getOrCreate(chatId: string, displayName: string): Promise<WhatsAppEmailThread>;
  findByToken(token: string): Promise<WhatsAppEmailThread | null>;
  findByMessageId(messageId: string): Promise<WhatsAppEmailThread | null>;
}

export function tokenFromSubject(subject: string): string | null {
  return /\[wa:([A-Za-z0-9_-]+)\]/.exec(subject)?.[1] ?? null;
}

export function tokenFromMessageId(messageId: string): string | null {
  return /^<?wa\.([A-Za-z0-9_-]+)(?:\.|@)/.exec(messageId.trim())?.[1] ?? null;
}

export function replyTextFor(text: string): string {
  const beforeMarker = text.split(replyMarker)[0]?.trim() ?? "";
  if (!beforeMarker) return "";

  const lines = beforeMarker.split("\n");
  const quotedStartIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return (
      /^On\s.+wrote:\s*$/.test(trimmed) ||
      /^-+\s?Original\sMessage-+\s*$/.test(trimmed) ||
      trimmed.startsWith(">")
    );
  });

  if (quotedStartIndex === -1) return beforeMarker;
  return lines.slice(0, quotedStartIndex).join("\n").trim();
}

export function forwardedMessageId(
  thread: WhatsAppEmailThread,
  whatsappMessageId: string,
): string {
  return `<wa.${thread.token}.${safeMessageIdPart(whatsappMessageId)}@${messageIdDomainFor(thread)}>`;
}

export async function threadForEmail(
  threads: WhatsAppEmailThreadStore,
  email: InboundEmail,
): Promise<WhatsAppEmailThread | null> {
  const subjectToken = tokenFromSubject(email.subject);

  if (subjectToken) {
    const thread = await threads.findByToken(subjectToken);

    if (thread) {
      return thread;
    }
  }

  for (const messageId of [email.inReplyTo, ...(email.references ?? [])]) {
    if (!messageId) {
      continue;
    }

    const token = tokenFromMessageId(messageId);
    const thread = token
      ? await threads.findByToken(token)
      : await threads.findByMessageId(messageId);

    if (thread) {
      return thread;
    }
  }

  return null;
}

function safeMessageIdPart(value: string): string {
  return Buffer.from(value ?? "unknown").toString("base64url");
}

function messageIdDomainFor(thread: WhatsAppEmailThread): string {
  return /@([^>]+)>?$/.exec(thread.rootMessageId.trim())?.[1] ??
    appDefaults.emailMessageIdDomain;
}
