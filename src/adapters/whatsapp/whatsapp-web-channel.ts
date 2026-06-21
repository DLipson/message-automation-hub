import pkg from "whatsapp-web.js";
import { platform } from "node:os";
import type { InboundMessage } from "../../domain/message.js";
import type {
  InboundChannel,
  InboundMessageHandler,
} from "../../ports/inbound-channel.js";
import type {
  WhatsAppDirectMessage,
  WhatsAppSender,
} from "../../ports/whatsapp-sender.js";

const { Client, LocalAuth } = pkg;

export type WhatsAppWebChannelConfig = {
  phoneNumber: string;
};

export class WhatsAppWebChannel implements InboundChannel, WhatsAppSender {
  private readonly client: InstanceType<typeof Client>;
  private handler?: InboundMessageHandler;

  constructor(config: WhatsAppWebChannelConfig) {
    this.client = new Client({
      authStrategy: new LocalAuth(),
      pairWithPhoneNumber: {
        phoneNumber: config.phoneNumber,
      },
      puppeteer: {
        args: browserArgs(),
      },
    });
  }

  onMessage(handler: InboundMessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.client.on("code", (code: string) => {
      console.log(`WhatsApp pairing code: ${code}`);
    });

    this.client.on("ready", () => {
      console.log("WhatsApp client is ready.");
    });

    this.client.on("message", async rawMessage => {
      if (!this.handler) {
        return;
      }

      await this.handler(this.toInboundMessage(rawMessage));
    });

    await this.client.initialize();
  }

  async sendMessage(message: WhatsAppDirectMessage): Promise<void> {
    await this.client.sendMessage(
      `${message.phoneNumber}@c.us`,
      message.text,
    );
  }

  private toInboundMessage(rawMessage: {
    id: { _serialized: string };
    from: string;
    body: string;
    timestamp: number;
    _data?: { notifyName?: string };
  }): InboundMessage {
    const from = rawMessage._data?.notifyName
      ? { id: rawMessage.from, displayName: rawMessage._data.notifyName }
      : { id: rawMessage.from };

    return {
      id: rawMessage.id._serialized,
      channel: "whatsapp",
      from,
      text: rawMessage.body,
      receivedAt: new Date(rawMessage.timestamp * 1000),
    };
  }
}

function browserArgs(): string[] {
  if (platform() !== "linux") {
    return [];
  }

  return ["--no-sandbox", "--disable-setuid-sandbox"];
}
