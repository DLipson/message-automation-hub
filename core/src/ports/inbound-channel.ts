import type { InboundMessage } from "../domain/message.js";

export type InboundMessageHandler = (message: InboundMessage) => Promise<void>;

export interface InboundChannel {
  onMessage(handler: InboundMessageHandler): void;
  start(): Promise<void>;
}
