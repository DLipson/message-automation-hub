import type { MediaAttachment } from "./media.js";

export type InboundEmail = {
  id: string;
  from?: string;
  subject: string;
  text: string;
  receivedAt: Date;
  attachments?: MediaAttachment[];
};