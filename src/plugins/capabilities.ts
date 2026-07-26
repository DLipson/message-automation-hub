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
} as const;
