import type { MediaAttachment } from "../domain/media.js";

export type WhatsAppDirectMessage = {
  phoneNumber: string;
  text: string;
};

export type WhatsAppDirectImage = {
  phoneNumber: string;
  text: string;
  image: MediaAttachment;
};

export type WhatsAppChatMessage = {
  chatId: string;
  text: string;
};

export type DeliveryStatus = 'sent' | 'delivered' | 'error';

export interface SentMessage {
  delivery: Promise<DeliveryStatus>;
}

export interface WhatsAppSender {
  sendMessage(message: WhatsAppDirectMessage): Promise<SentMessage>;
  sendImage(message: WhatsAppDirectImage): Promise<SentMessage>;
}

export interface WhatsAppChatSender {
  sendChatMessage(message: WhatsAppChatMessage): Promise<SentMessage>;
}

/**
 * Linking a device. Exposed over localhost HTTP by the bot control server, so
 * it needs a declared contract rather than whatever whatsapp-web.js happens to
 * offer. Codes are secrets: return them, never log them.
 */
export interface WhatsAppPairing {
  requestPairingCode(): Promise<string>;
}
