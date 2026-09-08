import pkg from "whatsapp-web.js";
import { platform } from "node:os";
import { appDefaults } from "../../config.js";
import { formatError } from "../../errors.js";
import type { InboundMessage } from "../../domain/message.js";
import type { MediaAttachment } from "../../domain/media.js";
import type { EmailSender } from "../../ports/email-sender.js";
import type {
  InboundChannel,
  InboundMessageHandler,
  WhatsAppGroupInviteHandler,
} from "../../ports/inbound-channel.js";
import type {
  DeliveryStatus,
  SentMessage,
  WhatsAppChatMessage,
  WhatsAppChatSender,
  WhatsAppDirectImage,
  WhatsAppDirectMessage,
  WhatsAppGroupInviteV4,
  WhatsAppPairing,
  WhatsAppSender,
} from "../../ports/whatsapp-sender.js";
import {
  JsonWhatsAppCatchUpStore,
  type CatchUpState,
} from "./json-whatsapp-catch-up-store.js";
import {
  CatchUpSweep,
  logWhatsApp,
  messageIdFor,
  serializedIdOf,
  type RawWhatsAppMessage,
} from "./whatsapp-catch-up-sweep.js";

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

// A successful download carries the media; a failure carries a human-readable
// reason so the error email can say WHY the bytes were unreachable (CDN 404,
// mediaStage error, page down) instead of a bare "could not download".
type MediaDownloadResult =
  | { media: RawWhatsAppMedia }
  | { reason: string };

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
  private readonly catchUpSweep: CatchUpSweep;
  private readonly groupNameCache = new Map<string, string>();
  private handler?: InboundMessageHandler;
  private groupInviteHandler?: WhatsAppGroupInviteHandler;
  private pairingCodeRequests = 0;
  private awaitingLinkLogged = false;
  private readyNotificationSent = false;
  private sessionEndHandled = false;
  private catchUpPending = true;
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
    this.catchUpSweep = new CatchUpSweep({
      store: config.catchUp?.store,
      chatLimit: config.catchUp?.chatLimit,
      messageLimitPerChat: config.catchUp?.messageLimitPerChat,
      getChats: () => this.client.getChats(),
      toInboundMessage: message => this.toInboundMessage(message),
      shouldHandle: message => this.shouldHandle(message),
      notifyError: (subject, text) => this.notifyError(subject, text),
      serializedIdOf,
      messageIdFor,
      log: logWhatsApp,
      stateRef: {
        get: () => this.catchUpState,
        set: state => { this.catchUpState = state; },
      },
    });
    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        args: browserArgs(),
        protocolTimeout: 120_000,
      },
    });
  }

  onMessage(handler: InboundMessageHandler): void {
    this.handler = handler;
    this.catchUpSweep.setForward(handler);
  }

  onGroupInvite(handler: WhatsAppGroupInviteHandler): void {
    this.groupInviteHandler = handler;
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
      void this.catchUpSweep.runCatchUpIfPending();
    });

    this.client.on("disconnected", async reason => {
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
      await this.notifyError(
        "Message Hub: WhatsApp session disconnected",
        [
          "WhatsApp session was disconnected (e.g. logged out from phone).",
          "Request a pairing code to reconnect once the service restarts.",
          "",
          `Reason: ${reasonText}`,
          `Time: ${new Date().toISOString()}`,
        ].join("\n"),
      );
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
      if (!this.handler && !this.groupInviteHandler) {
        return;
      }

      const msgId = messageIdFor(rawMessage);
      const sender = senderLabelFor(rawMessage);
      const msgType = rawMessage.type ? ` type: ${rawMessage.type}` : "";
      logWhatsApp(`Received message ${msgId} from ${sender}${msgType}`);

      try {
        if (
          rawMessage.type === "groups_v4_invite" &&
          rawMessage.inviteV4 &&
          this.groupInviteHandler
        ) {
          await this.groupInviteHandler(
            rawMessage.inviteV4,
            rawMessage.from,
            sender,
          );
          return;
        }

        if (!this.handler) {
          return;
        }

        if (!this.shouldHandle(rawMessage)) {
          return;
        }

        await this.handler(await this.toInboundMessage(rawMessage));
        this.catchUpSweep.trackWatermark(rawMessage.from, rawMessage.timestamp);
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

  async acceptInvite(inviteCode: string): Promise<string> {
    return this.sendWithContext(
      this.client.acceptInvite(inviteCode),
      "Accepting group invite",
    );
  }

  async acceptGroupV4Invite(
    inviteV4: WhatsAppGroupInviteV4,
  ): Promise<{ status: number }> {
    return this.sendWithContext(
      this.client.acceptGroupV4Invite(inviteV4),
      "Accepting group invite card",
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

    return { chatId, delivery };
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
    const notifyName = rawMessage._data?.notifyName;
    const isGroup = rawMessage.from.endsWith("@g.us");

    let displayName = notifyName;
    if (isGroup) {
      const groupName = await this.groupNameFor(rawMessage.from);
      displayName = groupName ?? notifyName;
    }

    const from = displayName
      ? { id: rawMessage.from, displayName }
      : { id: rawMessage.from };

    const author = isGroup
      ? (notifyName ?? rawMessage.author)
      : undefined;

    const attachments = await this.attachmentsFor(rawMessage);
    const quotedMessage = await this.quotedMessageFor(rawMessage);

    const messageId = serializedIdOf(rawMessage)
      ?? `unknown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      id: messageId,
      channel: "whatsapp",
      from,
      text: rawMessage.body,
      receivedAt: new Date(rawMessage.timestamp * 1000),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(author ? { author } : {}),
      ...(quotedMessage ? { quotedMessage } : {}),
    };
  }

  private async groupNameFor(chatId: string): Promise<string | undefined> {
    const cached = this.groupNameCache.get(chatId);
    if (cached) return cached;

    try {
      const chat = await this.client.getChatById(chatId);
      if (chat?.name) {
        this.groupNameCache.set(chatId, chat.name);
        return chat.name;
      }
    } catch (error) {
      logWhatsApp(`Failed to fetch group name for ${chatId}: ${formatError(error)}`);
    }
    return undefined;
  }

  private async quotedMessageFor(
    rawMessage: RawWhatsAppMessage,
  ): Promise<{ text: string; sender?: string } | undefined> {
    if (!rawMessage.hasQuotedMsg || !rawMessage.getQuotedMessage) return undefined;

    try {
      const quoted = await rawMessage.getQuotedMessage();
      const text = quoted.body ?? "";
      if (!text) return undefined;
      const sender = quoted._data?.notifyName ?? quoted.author;
      return sender ? { text, sender } : { text };
    } catch (error) {
      logWhatsApp(`Failed to fetch quoted message for ${messageIdFor(rawMessage)}: ${formatError(error)}`);
      return undefined;
    }
  }

  private async attachmentsFor(
    rawMessage: RawWhatsAppMessage,
  ): Promise<MediaAttachment[]> {
    if (!rawMessage.hasMedia || !rawMessage.downloadMedia) {
      return [];
    }

    const media = await this.tryDownloadMedia(rawMessage);

    if (!media || "reason" in media) {
      const msgId = messageIdFor(rawMessage);
      const sender = senderLabelFor(rawMessage);
      const reason = media && "reason" in media
        ? `Reason: ${media.reason}`
        : "Reason: no download path was available (hasMedia was set but the message exposed no media data).";
      logWhatsApp(`Media unavailable for message ${msgId} from ${sender}: ${reason}, forwarding without attachments`);
      await this.notifyError(
        `WhatsApp media download failed: ${msgId}`,
        notificationTextFor(rawMessage, msgId, sender, [
          "Message Automation Hub could not download media from a WhatsApp message.",
          "",
          reason,
          "",
          "The message was forwarded without attachments.",
        ]),
      );
      return [];
    }

    const filename = media.media.filename ?? filenameFor(media.media.mimetype);
    return [{
      content: Buffer.from(media.media.data, "base64"),
      contentType: media.media.mimetype,
      ...(filename ? { filename } : {}),
    }];
  }

  private async tryDownloadMedia(
    rawMessage: RawWhatsAppMessage,
  ): Promise<MediaDownloadResult | undefined> {
    const msgId = messageIdFor(rawMessage);
    const msgFrom = rawMessage.from;

    let libraryError: unknown;

    if (serializedIdOf(rawMessage)) {
      try {
        const media = await rawMessage.downloadMedia!();
        if (media) return { media };
      } catch (error) {
        libraryError = error;
        logWhatsApp(
          `media download failed for message ${msgId} from ${msgFrom}, trying direct download: ${formatError(error)}`,
        );
      }
    } else {
      logWhatsApp(
        `media download skipped library call for ${msgId}: missing _serialized, using direct download`,
      );
    }

    let direct: MediaDownloadResult | undefined;
    try {
      direct = await this.downloadMediaViaPage(msgId);
    } catch (error) {
      logWhatsApp(
        `Direct media download also failed for message ${msgId}: ${formatError(error)}`,
      );
      direct = { reason: `direct media download failed: ${formatError(error)}` };
    }

    if (direct && "media" in direct) return direct;

    const directReason = direct && "reason" in direct ? direct.reason : undefined;
    const reason = libraryError
      ? `library download failed (${formatError(libraryError)})` +
        (directReason ? `; direct download: ${directReason}` : "")
      : (directReason ?? "no download path produced media");
    return { reason };
  }

  private async downloadMediaViaPage(
    msgId: string,
  ): Promise<MediaDownloadResult> {
    if (!this.client.pupPage) {
      logWhatsApp(`Direct media download unavailable for ${msgId}: puppeteer page not initialized`);
      return { reason: "puppeteer page not initialized" };
    }

    const result = await this.client.pupPage.evaluate(
      async (id: string): Promise<
        | { data: string; mimetype: string; filename?: string | null }
        | { reason: string }
      > => {
        const msg = (window as any).require("WAWebCollections").Msg.get(id);
        if (!msg?.mediaData) return { reason: "message has no mediaData in the page" };

        if (msg.mediaData.mediaStage !== "RESOLVED") {
          try {
            await msg.downloadMedia({
              downloadEvenIfExpensive: true,
              rmrReason: 1,
            });
          } catch (error: any) {
            return { reason: `downloadMedia failed at mediaStage=${msg.mediaData.mediaStage}: ${String(error?.message ?? error)}` };
          }
        }

        if (
          !msg.mediaData.mediaStage ||
          msg.mediaData.mediaStage.includes("ERROR") ||
          msg.mediaData.mediaStage === "FETCHING"
        ) {
          return { reason: !msg.mediaData.mediaStage
            ? "mediaStage is missing (media not resolvable in the page)"
            : `mediaStage is ${msg.mediaData.mediaStage} (media errored or still fetching)` };
        }

        try {
          // ponytail: prefer the already-decrypted blob the msg.downloadMedia()
          // above leaves on mediaData.mediaBlob when the model keeps one
          // (version-dependent), then fall back to downloadAndMaybeDecrypt.
          //
          // downloadAndMaybeDecrypt (verified in the live bundle 2026-09-07)
          // passes `e.mimetype ?? "application/octet-stream"` through its mime
          // allowlist gate: an image arriving as application/octet-stream (old
          // chats) is NOT in the image allowlist and throws "Unexpected mimetype".
          // Passing an allowlisted mimetype explicitly lets the real bytes
          // through; the attachment keeps that usable type instead of octet-stream.
          const mediaType = msg.type === "ptt" ? "audio" : msg.type;
          const effectiveMime = msg.mimetype && msg.mimetype !== "application/octet-stream"
            ? msg.mimetype
            : mediaType === "image"
              ? "image/jpeg"
              : mediaType === "video"
                ? "video/mp4"
                : mediaType === "audio"
                  ? "audio/ogg; codecs=opus"
                  : mediaType === "sticker"
                    ? "image/webp"
                    : "application/octet-stream";

          // ponytail: version-dependent fast path; safe, some builds cache the
          // decrypted Blob here. When present the blob carries its own type.
          const blob = msg.mediaData?.mediaBlob;
          if (blob) {
            const data = await (window as any).WWebJS.arrayBufferToBase64Async(
              await blob.arrayBuffer(),
            );
            return {
              data,
              mimetype: blob.type || effectiveMime,
              filename: msg.filename,
            };
          }

          const mockQpl = {
            addAnnotations: function () {
              return this;
            },
            addPoint: function () {
              return this;
            },
          };

          const decryptedMedia = await (window as any)
            .require("WAWebDownloadManager")
            .downloadManager.downloadAndMaybeDecrypt({
              directPath: msg.directPath,
              encFilehash: msg.encFilehash,
              filehash: msg.filehash,
              mediaKey: msg.mediaKey,
              mediaKeyTimestamp: msg.mediaKeyTimestamp,
              type: mediaType,
              mimetype: effectiveMime,
              signal: new AbortController().signal,
              downloadQpl: mockQpl,
            });

          const data = await (window as any).WWebJS.arrayBufferToBase64Async(
            decryptedMedia,
          );

          return {
            data,
            mimetype: effectiveMime,
            filename: msg.filename,
          };
        } catch (e: any) {
          if (e.status && e.status === 404) return { reason: "WhatsApp returned 404 (media expired or pruned)" };
          return { reason: `downloadAndMaybeDecrypt failed: ${String(e?.message ?? e)}` };
        }
      },
      msgId,
    );

    if (!result) {
      logWhatsApp(`Direct media download unavailable for ${msgId}: page returned nothing`);
      return { reason: "page returned nothing (message not found in WhatsApp Web)" };
    }

    if ("reason" in result) {
      logWhatsApp(`Direct media download failed for ${msgId}: ${result.reason}`);
      return result;
    }

    return {
      media: {
        data: result.data,
        mimetype: result.mimetype,
        filename: result.filename ?? null,
      },
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
    "--mute-audio",
    "--disable-features=SitePerProcess",
    "--js-flags=--max-old-space-size=256",
  ];
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

