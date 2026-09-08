import type { MediaAttachment } from "./media.js";

export type MessageChannel = "whatsapp" | "email" | "telegram";

export type ContactRef = {
  id: string;
  displayName?: string;
};

export type QuotedMessage = {
  text: string;
  sender?: string;
};

export type InboundMessage = {
  id: string;
  channel: MessageChannel;
  from: ContactRef;
  text: string;
  receivedAt: Date;
  attachments?: MediaAttachment[];
  author?: string;
  quotedMessage?: QuotedMessage;
};