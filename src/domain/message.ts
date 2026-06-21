export type MessageChannel = "whatsapp" | "email" | "telegram";

export type ContactRef = {
  id: string;
  displayName?: string;
};

export type InboundMessage = {
  id: string;
  channel: MessageChannel;
  from: ContactRef;
  text: string;
  receivedAt: Date;
};
