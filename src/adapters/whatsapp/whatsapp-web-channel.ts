import pkg from "whatsapp-web.js";
import type { Chat } from "whatsapp-web.js";
import { platform } from "node:os";
import { appDefaults } from "../../config.js";
import { formatError } from "../../errors.js";
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
  WhatsAppPairing,
  WhatsAppSender,
} from "../../ports/whatsapp-sender.js";
import {
  JsonWhatsAppCatchUpStore,
  type CatchUpState,
} from "./json-whatsapp-catch-up-store.js";

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
  catchUp?: {
    store: JsonWhatsAppCatchUpStore;
    chatLimit?: number;
    messageLimitPerChat?: number;
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

// ponytail: WhatsApp Web renames this field without notice (_serialized -> $1, July 2026).
// Every read of a message's serialized id goes through here, so the next rename is one edit.
function serializedIdOf(message: RawWhatsAppMessage): string | undefined {
  const id = message.id;

  if (typeof id === "string") {
    return id;
  }

  if (!id || typeof id !== "object") {
    return undefined;
  }

  const holder = id as { _serialized?: string; "$1"?: string };
  return holder._serialized || holder.$1 || undefined;
}

// The library's own downloadMedia() reads id._serialized directly, so populate it too.
function normalizeId(message: RawWhatsAppMessage): void {
  const id = message.id;
  const serialized = serializedIdOf(message);

  if (id && typeof id === "object" && serialized && !id._serialized) {
    (id as { _serialized: string })._serialized = serialized;
  }
}

export class WhatsAppWebChannel
implements InboundChannel, WhatsAppSender, WhatsAppChatSender, WhatsAppPairing {
  private readonly client: InstanceType<typeof Client>;
  private readonly phoneNumber: string;
  private readonly sendTimeoutMs: number;
  private readonly forwardStatuses: WhatsAppForwardFilter;
  private readonly forwardGroups: WhatsAppForwardFilter;
  private readonly readyNotification?: WhatsAppWebChannelConfig["readyNotification"];
  private readonly errorNotification?: WhatsAppWebChannelConfig["errorNotification"];
  private readonly catchUp?: WhatsAppWebChannelConfig["catchUp"];
  private handler?: InboundMessageHandler;
  private pairingCodeRequests = 0;
  private awaitingLinkLogged = false;
  private readyNotificationSent = false;
  private sessionEndHandled = false;
  private catchUpPending = true;
  private catchUpInFlight = false;
  private catchUpState: CatchUpState | null = null;
  private linked = false;
  private unlinkedNotified = false;
  private deliveryQueue: Array<(status: DeliveryStatus) => void> = [];

  constructor(config: WhatsAppWebChannelConfig) {
    this.phoneNumber = config.phoneNumber;
    this.sendTimeoutMs = config.sendTimeoutMs ?? appDefaults.whatsappSendTimeoutMs;
    this.forwardStatuses = config.forwardStatuses ?? {};
    this.forwardGroups = config.forwardGroups ?? {};
    this.readyNotification = config.readyNotification;
    this.errorNotification = config.errorNotification;
    this.catchUp = config.catchUp;
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
      this.awaitingLinkLogged = false;
      logWhatsApp("Client authenticated.");
    });

    this.client.on("auth_failure", message => {
      logWhatsApp(`Authentication failed: ${formatError(message)}`);
    });

    this.client.on("ready", () => {
      logWhatsApp("Client is ready.");
      this.linked = true;
      this.unlinkedNotified = false;
      this.sendReadyNotification();
      void this.runCatchUpIfPending();
    });

    this.client.on("disconnected", reason => {
      if (this.sessionEndHandled) return;
      this.sessionEndHandled = true;
      this.catchUpPending = true;
      this.linked = false;
      const reasonText = formatError(reason);
      logWhatsApp(
        `Client disconnected: ${reasonText}. The WhatsApp session ended; restarting the service so a fresh client can re-link. Request a pairing code once it is back up.`,
      );
      // ponytail: whatsapp-web.js re-runs its own inject() after the logout
      // navigation and TWO concurrent calls race in exposeFunctionIfAbsent,
      // rejecting with `onQRChangedEvent already exists` (seen 2026-08-12, ~39s
      // after a LOGOUT). Exit now so systemd restarts a clean client instead of
      // dying on that cryptic unhandled rejection.
      process.exit(1);
    });

    this.client.on("change_state", state => {
      logWhatsApp(`State changed: ${formatError(state)}`);
    });

    this.client.on("loading_screen", (percent, message) => {
      logWhatsApp(
        `Loading screen ${formatError(percent)}%: ${formatError(message)}`,
      );
    });

    // whatsapp-web.js re-emits "qr" every ~20s while unlinked. Say so once per unlinked stretch
    // instead of every refresh, so a device waiting to be paired cannot bury real errors in the log.
    this.client.on("qr", () => {
      if (this.awaitingLinkLogged) return;
      this.awaitingLinkLogged = true;
      logWhatsApp(
        "Waiting to be linked. Nothing further will be logged until you use Request Pairing Code.",
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
        this.trackWatermark(rawMessage.from, rawMessage.timestamp);
      } catch (error) {
        const errorText = formatError(error);
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
    this.ensureLinked();
    const chatId = await this.sendWithContext(
      this.ensureChatForPhoneNumber(message.phoneNumber),
      `Chat lookup for ${message.phoneNumber}`,
    );
    return this.sendChatMessage({ chatId, text: message.text });
  }

  async sendChatMessage(message: WhatsAppChatMessage): Promise<SentMessage> {
    this.ensureLinked();
    return this.sendAndTrack(
      message.chatId,
      this.client.sendMessage(message.chatId, message.text),
    );
  }

  async sendImage(message: WhatsAppDirectImage): Promise<SentMessage> {
    this.ensureLinked();
    const chatId = await this.sendWithContext(
      this.ensureChatForPhoneNumber(message.phoneNumber),
      `Chat lookup for ${message.phoneNumber}`,
    );
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
    // whatsapp-web.js re-emits `ready` on every socket re-sync, so without this
    // guard a reconnect storm sends a stack of `ready` emails (seen 2026-08-12:
    // 8 emails in ~2s). Flagged before the await so concurrent ready events
    // cannot both sneak in while the first SMTP send is in flight.
    if (this.readyNotificationSent) return;
    this.readyNotificationSent = true;

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
        `Failed to send ready notification: ${formatError(error)}`,
      );
    }
  }

  private ensureLinked(): void {
    if (this.linked) return;
    this.notifyUnlinkedOnce();
    throw new Error("WhatsApp is not linked yet; request a pairing code");
  }

  private notifyUnlinkedOnce(): void {
    if (this.unlinkedNotified) return;
    this.unlinkedNotified = true;
    void this.notifyError(
      "Message Hub: WhatsApp needs re-linking",
      [
        "WhatsApp sends were attempted while the client is not linked.",
        "Request a pairing code to reconnect.",
        "",
        `Time: ${new Date().toISOString()}`,
      ].join("\n"),
    );
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
      logWhatsApp(`Failed to send error notification: ${formatError(sendError)}`);
    }
  }

  // Advances the persisted catch-up watermark after a message is forwarded.
  // `from` is the chat id for DMs and groups (`@c.us`/`@lid`/`@g.us`), matching
  // what the sweep keys on. The save rides the store's write queue.
  private trackWatermark(chatId: string | undefined, timestamp: number): void {
    if (!this.catchUp) return;
    if (!chatId) return;
    const state = this.catchUpState;
    if (!state || !state.initialized) return;
    const existing = state.chats[chatId] ?? 0;
    if (timestamp <= existing) return;
    state.chats[chatId] = timestamp;
    void this.catchUp.store.save(state).catch(error => {
      logWhatsApp(`Failed to persist catch-up watermark: ${formatError(error)}`);
    });
  }

  // Runs after the first `ready` and again after any `disconnected` + `ready`.
  // Sweeps the chats WhatsApp Web has loaded and forwards messages newer than the
  // last one we already handled, so an offline window (crash, logout) is not lost.
  // Idempotent via the watermark: the 8x `ready` re-sync storm finds nothing new.
  private async runCatchUpIfPending(): Promise<void> {
    if (this.catchUpInFlight) return;
    if (!this.catchUp || !this.handler) return;

    this.catchUpInFlight = true;
    try {
      const state = this.catchUpState ??= await this.catchUp.store.load();
      if (!state.initialized) {
        state.initialized = true;
        state.baseline = Math.floor(Date.now() / 1000);
        await this.catchUp.store.save(state);
        logWhatsApp(
          "Recorded catch-up baseline; not forwarding pre-existing history.",
        );
        return;
      }
      this.catchUpPending = false;
      if (Object.keys(state.chats).length === 0) return;
      await this.sweepForMissedMessages(state);
    } catch (error) {
      logWhatsApp(`Catch-up scan failed: ${formatError(error)}`);
    } finally {
      this.catchUpInFlight = false;
    }
  }

  private async sweepForMissedMessages(state: CatchUpState): Promise<void> {
    const chatLimit = this.catchUp?.chatLimit ?? 50;
    const messageLimit = this.catchUp?.messageLimitPerChat ?? 50;
    const watermarks = Object.values(state.chats);
    // A chat with no watermark yet starts from the catch-up baseline (or the oldest
    // watermark on stores written before `baseline` existed), so a first-contact
    // message during an offline/stuck window is still recovered.
    const startingFor = (chatId: string): number =>
      state.chats[chatId] ?? state.baseline
        ?? (watermarks.length > 0 ? Math.min(...watermarks) : 0);

    const chats = await this.getChatsWithRetry();
    for (const chat of chats.slice(0, chatLimit)) {
      const chatId = serializedIdOf(chat.id as unknown as RawWhatsAppMessage);
      if (!chatId) continue;
      const starting = startingFor(chatId);
      const lastTs = chat.lastMessage?.timestamp;
      if (lastTs !== undefined && lastTs <= starting) continue;

      try {
        const messages = await chat.fetchMessages({ limit: messageLimit });
        const candidates = messages.filter(message =>
          !message.fromMe &&
          message.timestamp > starting &&
          this.shouldHandle(message as unknown as RawWhatsAppMessage),
        );

        // Advance the watermark to whatever the page has loaded so a second sweep
        // (or a concurrent live message) does not re-forward it.
        const newest = messages[messages.length - 1]?.timestamp;
        if (newest !== undefined && newest > starting) {
          state.chats[chatId] = newest;
        }

        for (const message of candidates) {
          try {
            const inbound = await this.toInboundMessage(
              message as unknown as RawWhatsAppMessage,
            );
            await this.handler!(inbound);
            logWhatsApp(
              `Catch-up forwarded message ${messageIdFor(message as unknown as RawWhatsAppMessage)} from ${chatId}`,
            );
            const ts = message.timestamp;
            if (ts > (state.chats[chatId] ?? 0)) {
              state.chats[chatId] = ts;
            }
          } catch (error) {
            const msgId = messageIdFor(message as unknown as RawWhatsAppMessage);
            const errorText = formatError(error);
            logWhatsApp(`Catch-up failed for message ${msgId}: ${errorText}`);
            await this.notifyError(
              "WhatsApp catch-up message failed",
              `Message ID: ${msgId}\nChat: ${chatId}\nTime: ${new Date(message.timestamp * 1000).toISOString()}\n\nError:\n${errorText}`,
            );
          }
        }

        await this.catchUp!.store.save(state);
      } catch (error) {
        const errorText = formatError(error);
        logWhatsApp(`Catch-up sweep failed for chat ${chatId}: ${errorText}`);
        await this.notifyError(
          "WhatsApp catch-up sweep failed",
          `Chat: ${chatId}\n\nError:\n${errorText}`,
        );
      }
    }
  }

  // ponytail: the sweep runs ~seconds after `ready`, while the page is still
  // syncing chats, so getChats()'s page evaluate can throw (seen 2026-08-17 as
  // "Catch-up scan failed: r: r"). Retry a few times with a short delay; the
  // whole sweep previously died on the first transient failure.
  private async getChatsWithRetry(): Promise<Chat[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.client.getChats();
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          logWhatsApp(
            `Catch-up chat list attempt ${attempt} failed, retrying in 5s: ${formatError(error)}`,
          );
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
    throw lastError;
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
      throw new Error(`${description} failed: ${formatError(error)}`);
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

    const messageId = serializedIdOf(rawMessage)
      ?? `unknown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

    if (serializedIdOf(rawMessage)) {
      try {
        const media = await rawMessage.downloadMedia!();
        if (media) return media;
      } catch (error) {
        logWhatsApp(
          `media download failed for message ${msgId} from ${msgFrom}, trying direct download: ${formatError(error)}`,
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
        `Direct media download also failed for message ${msgId}: ${formatError(error)}`,
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
  const serialized = serializedIdOf(message);
  if (serialized) return serialized;

  const id = message.id;
  if (id && typeof id === "object") {
    // LID messages carry a short id plus fromMe; the serialized form is {fromMe}_{remote}_{id}.
    const idObj = id as { id?: string; fromMe?: boolean };
    if (idObj.id && message.from) {
      return `${idObj.fromMe === true ? "true" : "false"}_${message.from}_${idObj.id}`;
    }

    if (idObj.id) return idObj.id;
  }

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

