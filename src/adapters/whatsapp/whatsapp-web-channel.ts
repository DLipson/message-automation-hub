import pkg from "whatsapp-web.js";
import { platform } from "node:os";
import { appDefaults } from "../../config.js";
import type { InboundMessage } from "../../domain/message.js";
import type { MediaAttachment } from "../../domain/media.js";
import type { EmailSender } from "../../ports/email-sender.js";
import type {
  InboundChannel,
  InboundMessageHandler,
} from "../../ports/inbound-channel.js";
import type {
  DeliveryStatus,
  SentMessage,
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
  readyNotification?: {
    sender: EmailSender;
    from: string;
    to: string;
  };
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
  type?: string;
  downloadMedia?: () => Promise<RawWhatsAppMedia | undefined>;
  _data?: { notifyName?: string };
};

export class WhatsAppWebChannel implements InboundChannel, WhatsAppSender, WhatsAppChatSender {
  private readonly client: InstanceType<typeof Client>;
  private readonly phoneNumber: string;
  private readonly sendTimeoutMs: number;
  private readonly forwardStatuses: WhatsAppForwardFilter;
  private readonly forwardGroups: WhatsAppForwardFilter;
  private readonly readyNotification?: WhatsAppWebChannelConfig["readyNotification"];
  private handler?: InboundMessageHandler;
  private pairingCodeRequests = 0;
  private deliveryQueue: Array<(status: DeliveryStatus) => void> = [];

  constructor(config: WhatsAppWebChannelConfig) {
    this.phoneNumber = config.phoneNumber;
    this.sendTimeoutMs = config.sendTimeoutMs ?? appDefaults.whatsappSendTimeoutMs;
    this.forwardStatuses = config.forwardStatuses ?? {};
    this.forwardGroups = config.forwardGroups ?? {};
    this.readyNotification = config.readyNotification;
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
      this.sendReadyNotification();
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

    this.client.on("message_create", msg => {
      if (!msg.fromMe) return;

      const resolveDelivery = this.deliveryQueue.shift();
      if (!resolveDelivery) return;

      const onAck = (ackMsg: any, ack: number) => {
        if (ackMsg.id._serialized !== msg.id._serialized) return;

        if (ack === 2) {
          resolveDelivery("delivered");
          this.client.removeListener("message_ack", onAck);
        } else if (ack === -1) {
          resolveDelivery("error");
          this.client.removeListener("message_ack", onAck);
        }
      };
      this.client.on("message_ack", onAck);

      setTimeout(() => {
        resolveDelivery("sent");
        this.client.removeListener("message_ack", onAck);
      }, this.sendTimeoutMs);
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

  async sendMessage(message: WhatsAppDirectMessage): Promise<SentMessage> {
    const chatId = await this.ensureChatForPhoneNumber(message.phoneNumber);
    return this.sendChatMessage({ chatId, text: message.text });
  }

  async sendChatMessage(message: WhatsAppChatMessage): Promise<SentMessage> {
    return this.sendAndTrack(
      message.chatId,
      this.client.sendMessage(message.chatId, message.text),
    );
  }

  async sendImage(message: WhatsAppDirectImage): Promise<SentMessage> {
    const chatId = await this.ensureChatForPhoneNumber(message.phoneNumber);
    const media = new MessageMedia(
      message.image.contentType,
      message.image.content.toString("base64"),
      message.image.filename,
    );

    return this.sendAndTrack(
      chatId,
      this.client.sendMessage(chatId, media, {
        caption: message.text,
      }),
    );
  }

  private async sendReadyNotification(): Promise<void> {
    if (!this.readyNotification) return;

    try {
      await this.readyNotification.sender.send({
        from: this.readyNotification.from,
        to: this.readyNotification.to,
        subject: "Message Hub: WhatsApp client ready",
        text: [
          `WhatsApp client (${this.phoneNumber}) initialized successfully.`,
          "",
          `Time: ${new Date().toISOString()}`,
        ].join("\n"),
      });
      logWhatsApp("Sent ready notification email.");
    } catch (error) {
      logWhatsApp(
        `Failed to send ready notification: ${formatEventValue(error)}`,
      );
    }
  }

  private async sendAndTrack(
    chatId: string,
    send: Promise<any>,
  ): Promise<SentMessage> {
    let resolveDelivery!: (status: DeliveryStatus) => void;
    const delivery = new Promise<DeliveryStatus>(resolve => {
      resolveDelivery = resolve;
    });

    this.deliveryQueue.push(resolveDelivery);

    try {
      await this.sendWithContext(send, `WhatsApp send to ${chatId}`);
    } catch (error) {
      const idx = this.deliveryQueue.indexOf(resolveDelivery);
      if (idx !== -1) this.deliveryQueue.splice(idx, 1);
      throw error;
    }

    return { delivery };
  }

  private async ensureChatForPhoneNumber(phoneNumber: string): Promise<string> {
    const contactId = await this.client.getNumberId(phoneNumber);

    if (!contactId) {
      throw new Error(
        `WhatsApp number ${phoneNumber} is not registered or reachable`,
      );
    }

    const lid = contactId._serialized;
    const cusId = `${phoneNumber}@c.us`;

    const chatId = await this.client.pupPage!.evaluate(
      async (lidStr: string, cusStr: string) => {
        for (const id of [lidStr, cusStr]) {
          try {
            const wid = (window as any).require("WAWebWidFactory").createWid(id);
            const existing = (window as any).require("WAWebCollections").Chat.get(wid);
            if (existing) return id;

            await (window as any)
              .require("WAWebFindChatAction")
              .findOrCreateLatestChat(wid);

            const chat = (window as any).require("WAWebCollections").Chat.get(wid);
            if (chat) return id;
          } catch {}
        }
        return null;
      },
      lid,
      cusId,
    );

    if (!chatId) {
      throw new Error(
        `Could not create WhatsApp chat for ${phoneNumber}`,
      );
    }

    return chatId;
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

    const messageId = rawMessage.id?._serialized ?? `unknown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      id: messageId,
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

    const media = await this.tryDownloadMedia(rawMessage);

    if (!media) {
      return [];
    }

    return [{
      content: Buffer.from(media.data, "base64"),
      contentType: media.mimetype,
      ...(media.filename ? { filename: media.filename } : {}),
    }];
  }

  private async tryDownloadMedia(
    rawMessage: RawWhatsAppMessage,
  ): Promise<RawWhatsAppMedia | undefined> {
    try {
      const media = await rawMessage.downloadMedia();
      if (media) return media;
    } catch (error) {
      logWhatsApp(
        `downloadMedia() failed, trying direct download: ${formatEventValue(error)}`,
      );
    }

    try {
      return await this.downloadMediaViaPage(rawMessage.id._serialized);
    } catch (error) {
      logWhatsApp(
        `Direct media download also failed: ${formatEventValue(error)}`,
      );
      return undefined;
    }
  }

  private async downloadMediaViaPage(
    msgId: string,
  ): Promise<RawWhatsAppMedia | undefined> {
    const result = await this.client.pupPage!.evaluate(
      async (id: string) => {
        const msg = (window as any).require("WAWebCollections").Msg.get(id);
        if (!msg?.mediaData) return undefined;

        if (msg.mediaData.mediaStage !== "RESOLVED") {
          try {
            await msg.downloadMedia({
              downloadEvenIfExpensive: true,
              rmrReason: 1,
            });
          } catch {
            return undefined;
          }
        }

        if (
          msg.mediaData.mediaStage.includes("ERROR") ||
          msg.mediaData.mediaStage === "FETCHING"
        ) {
          return undefined;
        }

        try {
          const mockQpl = {
            addAnnotations: function () {
              return this;
            },
            addPoint: function () {
              return this;
            },
          };

          const mediaType = msg.type === "ptt" ? "audio" : msg.type;

          const decryptedMedia = await (window as any)
            .require("WAWebDownloadManager")
            .downloadManager.downloadAndMaybeDecrypt({
              directPath: msg.directPath,
              encFilehash: msg.encFilehash,
              filehash: msg.filehash,
              mediaKey: msg.mediaKey,
              mediaKeyTimestamp: msg.mediaKeyTimestamp,
              type: mediaType,
              signal: new AbortController().signal,
              downloadQpl: mockQpl,
            });

          const data = await (window as any).WWebJS.arrayBufferToBase64Async(
            decryptedMedia,
          );

          return {
            data,
            mimetype: msg.mimetype,
            filename: msg.filename,
            filesize: msg.size,
          };
        } catch (e: any) {
          if (e.status && e.status === 404) return undefined;
          throw e;
        }
      },
      msgId,
    );

    if (!result) return undefined;

    return {
      data: result.data,
      mimetype: result.mimetype,
      filename: result.filename ?? null,
    };
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
