import type { InboundMessage } from "../domain/message.js";
import type { WhatsAppGroupInviteV4 } from "./whatsapp-sender.js";

export type InboundMessageHandler = (message: InboundMessage) => Promise<void>;

export type WhatsAppGroupInviteHandler = (
  inviteV4: WhatsAppGroupInviteV4,
  fromId: string,
  senderLabel: string,
) => Promise<void> | void;

export interface InboundChannel {
  onMessage(handler: InboundMessageHandler): void;
  onGroupInvite(handler: WhatsAppGroupInviteHandler): void;
  start(): Promise<void>;
}
