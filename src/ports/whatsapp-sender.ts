export type WhatsAppDirectMessage = {
  phoneNumber: string;
  text: string;
};

export interface WhatsAppSender {
  sendMessage(message: WhatsAppDirectMessage): Promise<void>;
}
