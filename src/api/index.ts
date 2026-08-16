import type { InboundEmail } from "../domain/email.js";
import type { MediaAttachment } from "../domain/media.js";
import type { ContactRef, InboundMessage } from "../domain/message.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailMessage } from "../ports/email-sender.js";
import type {
  WhatsAppSender, WhatsAppChatSender,
  DeliveryStatus, WhatsAppGroupInviteV4,
  SentMessage, WhatsAppChatMessage, WhatsAppDirectImage, WhatsAppDirectMessage,
} from "../ports/whatsapp-sender.js";
import type { EmailAutomationBatch } from "../use-cases/process-email-automations.js";
import type { CapabilityName } from "../core/plugin-runtime.js";

export const capabilities = {
  appLogger: "app.logger",
  emailInbox: "email.receive",
  emailLabeler: "email.labels",
  emailSender: "email.send",
  emailStatusMarker: "email.status",
  threadStore: "thread.map",
  whatsappChatSender: "whatsapp.chat.send",
  whatsappInbound: "whatsapp.receive",
  whatsappPairing: "whatsapp.pairing",
  whatsappSender: "whatsapp.send",
} as const satisfies Record<string, CapabilityName>;

export type {
  Capabilities, CapabilityName,
  EventMap, EventName, EventHandler,
  HubPlugin, PluginContext,
} from "../core/plugin-runtime.js";

export type { InboundEmail, MediaAttachment };
export type { ContactRef, InboundMessage };
export type { AppLogger };
export type { EmailMessage };
export type {
  WhatsAppSender, WhatsAppChatSender,
  DeliveryStatus, WhatsAppGroupInviteV4,
  SentMessage, WhatsAppChatMessage, WhatsAppDirectImage, WhatsAppDirectMessage,
};
export type { EmailAutomationBatch } from "../use-cases/process-email-automations.js";