import type { InboundEmail } from "../domain/email.js";
import type { MediaAttachment } from "../domain/media.js";
import type { ContactRef, InboundMessage } from "../domain/message.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailSender, EmailMessage } from "../ports/email-sender.js";
import type { EmailInbox, EmailLabeler, EmailStatusMarker } from "../ports/email-inbox.js";
import type {
  WhatsAppSender, WhatsAppChatSender, WhatsAppPairing,
  SentMessage, WhatsAppChatMessage, WhatsAppDirectImage, WhatsAppDirectMessage,
} from "../ports/whatsapp-sender.js";
import type { InboundChannel, InboundMessageHandler } from "../ports/inbound-channel.js";
import type { WhatsAppEmailThread, WhatsAppEmailThreadStore } from "../use-cases/whatsapp-email-thread-store.js";
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

export type { Capabilities, CapabilityName, HubPlugin, PluginContext } from "../core/plugin-runtime.js";

export type { InboundEmail, MediaAttachment };
export type { ContactRef, InboundMessage };
export type { AppLogger };
export type { EmailSender, EmailMessage };
export type { EmailInbox, EmailLabeler, EmailStatusMarker };
export type {
  WhatsAppSender, WhatsAppChatSender, WhatsAppPairing,
  SentMessage, WhatsAppChatMessage, WhatsAppDirectImage, WhatsAppDirectMessage,
};
export type { InboundChannel, InboundMessageHandler };
export type { WhatsAppEmailThread, WhatsAppEmailThreadStore };
export type { EmailAutomationBatch, EmailAutomationHandler } from "../use-cases/process-email-automations.js";