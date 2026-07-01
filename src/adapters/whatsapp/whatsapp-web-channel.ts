import pkg from "whatsapp-web.js";
import { platform } from "node:os";
import type { InboundMessage } from "../../domain/message.js";
import type { MediaAttachment } from "../../domain/media.js";
import type {
  InboundChannel,
  InboundMessageHandler,
} from "../../ports/inbound-channel.js";
import type {
  WhatsAppDirectImage,
  WhatsAppDirectMessage,
  WhatsAppSender,
} from "../../ports/whatsapp-sender.js";

const { Client, LocalAuth, MessageMedia } = pkg;

export type WhatsAppWebChannelConfig = {
  phoneNumber: string;
};

type RawWhatsAppMedia = {
  mimetype: string;
  data: string;
  filename?: string | null;
};

type RawWhatsAppMessage = {
  id: { _serialized: string };
  from: string;
  body: string;
  timestamp: number;
  hasMedia?: boolean;
  downloadMedia?: () => Promise<RawWhatsAppMedia | undefined>;
  _data?: { notifyName?: string };
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

      await this.handler(await this.toInboundMessage(rawMessage));
    });

    await this.client.initialize();
  }

  async sendMessage(message: WhatsAppDirectMessage): Promise<void> {
    await this.client.sendMessage(
      `${message.phoneNumber}@c.us`,
      message.text,
    );
  }

  async sendImage(message: WhatsAppDirectImage): Promise<void> {
    const media = new MessageMedia(
      message.image.contentType,
      message.image.content.toString("base64"),
      message.image.filename,
    );

    await this.client.sendMessage(`${message.phoneNumber}@c.us`, media, {
      caption: message.text,
    });
  }

  private async toInboundMessage(
    rawMessage: RawWhatsAppMessage,
  ): Promise<InboundMessage> {
    const from = rawMessage._data?.notifyName
      ? { id: rawMessage.from, displayName: rawMessage._data.notifyName }
      : { id: rawMessage.from };
    const attachments = await this.attachmentsFor(rawMessage);

    return {
      id: rawMessage.id._serialized,
      channel: "whatsapp",
      from,
      text: rawMessage.body,
      receivedAt: new Date(rawMessage.timestamp * 1000),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  private async attachmentsFor(
    rawMessage: RawWhatsAppMessage,
  ): Promise<MediaAttachment[]> {
    if (!rawMessage.hasMedia || !rawMessage.downloadMedia) {
      return [];
    }

    const media = await rawMessage.downloadMedia();

    if (!media?.mimetype.toLowerCase().startsWith("image/")) {
      return [];
    }

    return [{
      content: Buffer.from(media.data, "base64"),
      contentType: media.mimetype,
      ...(media.filename ? { filename: media.filename } : {}),
    }];
  }
}

function browserArgs(): string[] {
  if (platform() !== "linux") {
    return [];
  }

  return ["--no-sandbox", "--disable-setuid-sandbox"];
}