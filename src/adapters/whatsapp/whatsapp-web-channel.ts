import pkg from "whatsapp-web.js";
import { platform } from "node:os";
import { appDefaults } from "../../config.js";
import type { InboundMessage } from "../../domain/message.js";
import type { MediaAttachment } from "../../domain/media.js";
import type {
  InboundChannel,
  InboundMessageHandler,
} from "../../ports/inbound-channel.js";
import type {
  WhatsAppChatMessage,
  WhatsAppChatSender,
  WhatsAppDirectImage,
  WhatsAppDirectMessage,
  WhatsAppSender,
} from "../../ports/whatsapp-sender.js";

const { Client, LocalAuth, MessageMedia } = pkg;
const maxSignedIntTimerDelayMs = 2_147_483_647;

export type WhatsAppForwardFilter = {
  enabled?: boolean;
  whitelist?: string[];
  blacklist?: string[];
};

export type WhatsAppWebChannelConfig = {
  phoneNumber: string;
  sendTimeoutMs?: number;
  forwardStatuses?: WhatsAppForwardFilter;
  forwardGroups?: WhatsAppForwardFilter;
};

type RawWhatsAppMedia = {
  mimetype: string;
  data: string;
  filename?: string | null;
};

type RawWhatsAppMessage = {
  id: { _serialized: string };
  from: string;
  author?: string;
  body: string;
  timestamp: number;
  hasMedia?: boolean;
  downloadMedia?: () => Promise<RawWhatsAppMedia | undefined>;
  _data?: { notifyName?: string };
};

export class WhatsAppWebChannel implements InboundChannel, WhatsAppSender, WhatsAppChatSender {
  private readonly client: InstanceType<typeof Client>;
  private readonly phoneNumber: string;
  private readonly sendTimeoutMs: number;
  private readonly forwardStatuses: WhatsAppForwardFilter;
  private readonly forwardGroups: WhatsAppForwardFilter;
  private handler?: InboundMessageHandler;
  private pairingCodeRequests = 0;

  constructor(config: WhatsAppWebChannelConfig) {
    this.phoneNumber = config.phoneNumber;
    this.sendTimeoutMs = config.sendTimeoutMs ?? appDefaults.whatsappSendTimeoutMs;
    this.forwardStatuses = config.forwardStatuses ?? {};
    this.forwardGroups = config.forwardGroups ?? {};
    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        args: browserArgs(),
      },
    });
  }

  onMessage(handler: InboundMessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.client.on("code", () => {
      this.pairingCodeRequests += 1;
      logWhatsApp(
        `Pairing code requested (#${this.pairingCodeRequests}). Use the authenticated settings UI to view it.`,
      );
    });

    this.client.on("authenticated", () => {
      logWhatsApp("Client authenticated.");
    });

    this.client.on("auth_failure", message => {
      logWhatsApp(`Authentication failed: ${formatEventValue(message)}`);
    });

    this.client.on("ready", () => {
      logWhatsApp("Client is ready.");
    });

    this.client.on("disconnected", reason => {
      logWhatsApp(`Client disconnected: ${formatEventValue(reason)}`);
    });

    this.client.on("change_state", state => {
      logWhatsApp(`State changed: ${formatEventValue(state)}`);
    });

    this.client.on("loading_screen", (percent, message) => {
      logWhatsApp(
        `Loading screen ${formatEventValue(percent)}%: ${formatEventValue(message)}`,
      );
    });

    this.client.on("qr", () => {
      logWhatsApp(
        "QR login requested. Phone-number pairing code was not requested automatically; use Request Pairing Code when you are ready to link a device.",
      );
    });

    this.client.on("message", async rawMessage => {
      if (!this.handler) {
        return;
      }

      try {
        if (!this.shouldHandle(rawMessage)) {
          return;
        }

        await this.handler(await this.toInboundMessage(rawMessage));
      } catch (error) {
        logWhatsApp(`Message handler failed: ${formatEventValue(error)}`);
      }
    });

    logWhatsApp("Initializing client.");
    await this.client.initialize();
  }

  async requestPairingCode(): Promise<string> {
    logWhatsApp("Manual pairing code request received.");
    return await this.client.requestPairingCode(
      this.phoneNumber,
      true,
      maxSignedIntTimerDelayMs,
    );
  }

  async sendMessage(message: WhatsAppDirectMessage): Promise<void> {
    const chatId = await this.resolveChatId(message.phoneNumber);
    await this.sendChatMessage({ chatId, text: message.text });
  }

  async sendChatMessage(message: WhatsAppChatMessage): Promise<void> {
    const sentMessage = await this.sendWithContext(
      this.client.sendMessage(message.chatId, message.text, {
        waitUntilMsgSent: true,
      }),
      `WhatsApp text send to ${message.chatId}`,
    );

    if (!sentMessage) {
      throw new Error(
        `WhatsApp text send to ${message.chatId} returned no message`,
      );
    }
  }

  async sendImage(message: WhatsAppDirectImage): Promise<void> {
    const chatId = await this.resolveChatId(message.phoneNumber);
    const media = new MessageMedia(
      message.image.contentType,
      message.image.content.toString("base64"),
      message.image.filename,
    );

    const sentMessage = await this.sendWithContext(
      this.client.sendMessage(chatId, media, {
        caption: message.text,
        waitUntilMsgSent: true,
      }),
      `WhatsApp image send to ${chatId}`,
    );

    if (!sentMessage) {
      throw new Error(`WhatsApp image send to ${chatId} returned no message`);
    }
  }

  private async resolveChatId(phoneNumber: string): Promise<string> {
    const contactId = await this.client.getNumberId(phoneNumber);

    if (!contactId) {
      throw new Error(
        `WhatsApp number ${phoneNumber} is not registered or reachable`,
      );
    }

    return contactId._serialized;
  }

  private async sendWithContext<T>(
    send: Promise<T>,
    description: string,
  ): Promise<T> {
    try {
      return await withTimeout(send, this.sendTimeoutMs, description);
    } catch (error) {
      throw new Error(`${description} failed: ${formatEventValue(error)}`);
    }
  }

  private shouldHandle(rawMessage: RawWhatsAppMessage): boolean {
    if (rawMessage.from === "status@broadcast") {
      return Boolean(this.forwardStatuses.enabled) && isAllowed(
        rawMessage.author ?? rawMessage.from,
        this.forwardStatuses,
      );
    }

    if (rawMessage.from.endsWith("@g.us")) {
      return Boolean(this.forwardGroups.enabled) && isAllowed(
        rawMessage.from,
        this.forwardGroups,
      );
    }

    return true;
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

    if (!media) {
      return [];
    }

    return [{
      content: Buffer.from(media.data, "base64"),
      contentType: media.mimetype,
      ...(media.filename ? { filename: media.filename } : {}),
    }];
  }
}

function isAllowed(id: string, filter: WhatsAppForwardFilter): boolean {
  if (filter.whitelist?.length) {
    return filter.whitelist.includes(id);
  }

  return !filter.blacklist?.includes(id);
}

function browserArgs(): string[] {
  if (platform() !== "linux") {
    return [];
  }

  return [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-gpu",
    "--disable-sync",
    "--no-first-run",
  ];
}

function logWhatsApp(message: string): void {
  console.log(`[${new Date().toISOString()}] WhatsApp ${message}`);
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  description: string,
): Promise<T> {
  let timeout: NodeJS.Timeout;
  const timer = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${description} timed out after ${milliseconds}ms`));
    }, milliseconds);
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timeout)),
    timer,
  ]);
}

function formatEventValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
