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

/**
 * Data attached to a WhatsApp group-invite card (type: groups_v4_invite).
 * The accept call needs the full record, not just the code: the V4 job joins
 * with code + expiry + group id + inviter id.
 */
export type WhatsAppGroupInviteV4 = {
  inviteCode: string;
  inviteCodeExp: number;
  groupId: string;
  groupName?: string;
  fromId: string;
  toId: string;
};

export interface WhatsAppChatSender {
  sendChatMessage(message: WhatsAppChatMessage): Promise<SentMessage>;
  acceptInvite(inviteCode: string): Promise<string>;
  acceptGroupV4Invite(inviteV4: WhatsAppGroupInviteV4): Promise<{ status: number }>;
}

/**
 * Linking a device. Exposed over localhost HTTP by the bot control server, so
 * it needs a declared contract rather than whatever whatsapp-web.js happens to
 * offer. Codes are secrets: return them, never log them.
 */
export interface WhatsAppPairing {
  requestPairingCode(): Promise<string>;
}
