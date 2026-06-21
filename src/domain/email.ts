export type InboundEmail = {
  id: string;
  from?: string;
  subject: string;
  text: string;
  receivedAt: Date;
};
