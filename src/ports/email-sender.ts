import type { MediaAttachment } from "../domain/media.js";

export type EmailMessage = {
  to: string;
  from: string;
  subject: string;
  text: string;
  attachments?: MediaAttachment[];
};

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}