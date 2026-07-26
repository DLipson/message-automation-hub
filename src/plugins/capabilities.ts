import type { CapabilityName } from "../core/plugin-runtime.js";

// Short aliases for the capability names. `satisfies` catches a typo here
// instead of at startup; the types behind each name live in Capabilities.
export const capabilities = {
  appLogger: "app.logger",
  emailAutomationHandlers: "email.automation.handlers",
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
