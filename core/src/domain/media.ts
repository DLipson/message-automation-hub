export type MediaAttachment = {
  content: Buffer;
  contentType: string;
  filename?: string;
};

export function isImageAttachment(attachment: MediaAttachment): boolean {
  return attachment.contentType.toLowerCase().startsWith("image/");
}