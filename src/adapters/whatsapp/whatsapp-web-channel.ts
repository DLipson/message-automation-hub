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
  errorNotification?: {
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
  id: { _serialized: string; "$1"?: string };
  from: string;
  author?: string;
  body: string;
  timestamp: number;
  hasMedia?: boolean;
  type?: string;
  downloadMedia?: () => Promise<RawWhatsAppMedia | undefined>;
  _data?: { notifyName?: string };
};

function normalizeId(message: RawWhatsAppMessage): void {
  const id = message.id;
  if (
    id &&
    typeof id === "object" &&
    "_serialized" in id &&
    id._serialized
  ) {
    return;
  }
  if (id && typeof id === "object" && "$1" in id) {
    const dollarId = id as { "$1": string };
    if (dollarId.$1) {
      (id as { _serialized: string })._serialized = dollarId.$1;
    }
  }
}

export class WhatsAppWebChannel implements InboundChannel, WhatsAppSender, WhatsAppChatSender {
  private readonly client: InstanceType<typeof Client>;
  private readonly phoneNumber: string;
  private readonly sendTimeoutMs: number;
  private readonly forwardStatuses: WhatsAppForwardFilter;
  private readonly forwardGroups: WhatsAppForwardFilter;
  private readonly readyNotification?: WhatsAppWebChannelConfig["readyNotification"];
  private readonly errorNotification?: WhatsAppWebChannelConfig["errorNotification"];
  private handler?: InboundMessageHandler;
  private pairingCodeRequests = 0;
  private deliveryQueue: Array<(status: DeliveryStatus) => void> = [];

  constructor(config: WhatsAppWebChannelConfig) {
    this.phoneNumber = config.phoneNumber;
    this.sendTimeoutMs = config.sendTimeoutMs ?? appDefaults.whatsappSendTimeoutMs;
    this.forwardStatuses = config.forwardStatuses ?? {};
    this.forwardGroups = config.forwardGroups ?? {};
    this.readyNotification = config.readyNotification;
    this.errorNotification = config.errorNotification;
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
      normalizeId(rawMessage);
      if (!this.handler) {
        return;
      }

      const msgId = messageIdFor(rawMessage);
      const sender = senderLabelFor(rawMessage);
      const msgType = rawMessage.type ? ` type: ${rawMessage.type}` : "";
      logWhatsApp(`Received message ${msgId} from ${sender}${msgType}`);

      try {
        if (!this.shouldHandle(rawMessage)) {
          return;
        }

        await this.handler(await this.toInboundMessage(rawMessage));
      } catch (error) {
        const errorText = formatEventValue(error);
        logWhatsApp(`Message handler failed for message ${msgId}: ${errorText}`);
        await this.notifyError(
          `WhatsApp message handler failed: ${msgId}`,
          notificationTextFor(rawMessage, msgId, sender, ["Error:", errorText]),
        );
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

  private async notifyError(subject: string, text: string): Promise<void> {
    if (!this.errorNotification) return;

    try {
      await this.errorNotification.sender.send({
        from: this.errorNotification.from,
        to: this.errorNotification.to,
        subject,
        text,
      });
    } catch (sendError) {
      logWhatsApp(`Failed to send error notification: ${formatEventValue(sendError)}`);
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
    let lid: string | undefined;
    try {
      const contactId = await this.client.getNumberId(phoneNumber);
      if (contactId) lid = contactId._serialized;
    } catch {
      // getNumberId can fail with transient Puppeteer page errors;
      // fall through to direct evaluation with both formats
    }

    const cusId = `${phoneNumber}@c.us`;
    const ids = lid ? [lid, cusId] : [cusId];

    const chatId = await this.client.pupPage!.evaluate(
      async (idList: string[]) => {
        for (const id of idList) {
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
      ids,
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

    const serializedId = rawMessage.id && typeof rawMessage.id === "object" && "_serialized" in rawMessage.id
      ? (rawMessage.id as { _serialized?: string })._serialized
      : undefined;
    const messageId = serializedId ?? `unknown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
      const msgId = messageIdFor(rawMessage);
      const sender = senderLabelFor(rawMessage);
      logWhatsApp(`Media unavailable for message ${msgId} from ${sender}, forwarding without attachments`);
      await this.notifyError(
        `WhatsApp media download failed: ${msgId}`,
        notificationTextFor(rawMessage, msgId, sender, [
          "Message Automation Hub could not download media from a WhatsApp message.",
          "",
          "The message was forwarded without attachments.",
        ]),
      );
      return [];
    }

    const filename = media.filename ?? filenameFor(media.mimetype);
    return [{
      content: Buffer.from(media.data, "base64"),
      contentType: media.mimetype,
      ...(filename ? { filename } : {}),
    }];
  }

  private async tryDownloadMedia(
    rawMessage: RawWhatsAppMessage,
  ): Promise<RawWhatsAppMedia | undefined> {
    const msgId = messageIdFor(rawMessage);
    const msgFrom = rawMessage.from;
    const hasSerialized = rawMessage.id && typeof rawMessage.id === "object" && "_serialized" in rawMessage.id
      && !!(rawMessage.id as { _serialized?: string })._serialized;

    if (hasSerialized) {
      try {
        const media = await rawMessage.downloadMedia!();
        if (media) return media;
      } catch (error) {
        logWhatsApp(
          `media download failed for message ${msgId} from ${msgFrom}, trying direct download: ${formatEventValue(error)}`,
        );
      }
    } else {
      logWhatsApp(
        `media download skipped library call for ${msgId}: missing _serialized, using direct download`,
      );
    }

    try {
      return await this.downloadMediaViaPage(msgId);
    } catch (error) {
      logWhatsApp(
        `Direct media download also failed for message ${msgId}: ${formatEventValue(error)}`,
      );
      return undefined;
    }
  }

  private async downloadMediaViaPage(
    msgId: string,
  ): Promise<RawWhatsAppMedia | undefined> {
    if (!this.client.pupPage) {
      logWhatsApp(`Direct media download unavailable for ${msgId}: puppeteer page not initialized`);
      return undefined;
    }

    const result = await this.client.pupPage.evaluate(
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

function messageIdFor(message: RawWhatsAppMessage): string {
  const id = message.id;
  if (id && typeof id === "object") {
    if ("_serialized" in id) {
      const serialized = (id as { _serialized?: string })._serialized;
      if (serialized) return serialized;
    }

    const idObj = id as { id?: string; fromMe?: boolean };
    if (idObj.id && message.from) {
      const prefix = idObj.fromMe === true ? "true" : "false";
      return `${prefix}_${message.from}_${idObj.id}`;
    }

    if (idObj.id) return idObj.id;
  }
  if (id && typeof id === "string") return id;
  try { return JSON.stringify(id); } catch { return "unknown"; }
}

function senderLabelFor(message: RawWhatsAppMessage): string {
  const displayName = message._data?.notifyName;
  return displayName ? `${displayName} (${message.from})` : message.from;
}

function notificationTextFor(
  message: RawWhatsAppMessage,
  msgId: string,
  sender: string,
  extra: string[],
): string {
  const type = message.type ?? "unknown";
  const body = message.body || "(no text)";
  return [
    ...extra,
    "",
    `Message ID: ${msgId}`,
    `Sender: ${sender}`,
    `Type: ${type}`,
    `Body: ${body}`,
    `Time: ${new Date(message.timestamp * 1000).toISOString()}`,
  ].join("\n");
}

function filenameFor(mimetype: string): string | undefined {
  const base = mimetype.split(";")[0];
  if (!base) return undefined;
  const clean = base.trim().toLowerCase();
  const slashIdx = clean.indexOf("/");
  if (slashIdx === -1) return undefined;
  const ext = clean.slice(slashIdx + 1);
  if (!ext || ext.includes(" ")) return undefined;
  return `${clean.slice(0, slashIdx)}.${ext}`;
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
