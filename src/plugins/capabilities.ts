export const capabilities = {
  appLogger: "app.logger",
  emailAutomationHandlers: "email.automation.handlers",
  emailInbox: "email.receive",
  emailSender: "email.send",
  threadStore: "thread.map",
  whatsappChannel: "whatsapp.channel",
  whatsappChatSender: "whatsapp.chat.send",
  whatsappInbound: "whatsapp.receive",
  whatsappSender: "whatsapp.send",
} as const;
