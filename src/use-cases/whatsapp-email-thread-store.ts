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
  return text.split(replyMarker)[0]?.trim() ?? "";
}

export function forwardedMessageId(
  thread: WhatsAppEmailThread,
  whatsappMessageId: string,
): string {
  return `<wa.${thread.token}.${safeMessageIdPart(whatsappMessageId)}@message-automation-hub.local>`;
}

function safeMessageIdPart(value: string): string {
  return Buffer.from(value).toString("base64url");
}
