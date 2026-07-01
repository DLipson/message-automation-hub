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

export interface WhatsAppSender {
  sendMessage(message: WhatsAppDirectMessage): Promise<void>;
  sendImage(message: WhatsAppDirectImage): Promise<void>;
}