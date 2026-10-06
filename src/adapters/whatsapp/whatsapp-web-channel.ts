import pkg from "whatsapp-web.js";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";
import { addExtra } from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
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

// WhatsApp Web build the wwebjs shim is verified to work against. Serving this
// pinned build instead of whatever WhatsApp's CDN currently serves keeps the
// session alive when WhatsApp rolls a build whose internals break the shim
// (prod hit this 2026-09-09: authenticated x3, Invariant #56367, immediate
// LOGOUT on build 2.3000.1047051837). WhatsApp's server also stops accepting
// NEW device links from too-old builds (2026-10-04: pairing code was accepted
// by the phone, reached 100% loading, then the server revoked the session ~7s
// later on the then-pinned 2.3000.1046977494). Bump deliberately: prefer the
// build wppconnect-tracker currently marks current. The HTML ships in
// src/adapters/whatsapp/web-versions/ and is copied to dist/ by the build
// script (same pattern as settings-page.html).
const pinnedWhatsAppWebVersion = "2.3000.1049263829";

const pinnedWebVersionsDir = fileURLToPath(
  new URL("./web-versions/", import.meta.url),
);

// Session supervision. whatsapp-web.js can report "ready" and stay connected
// while its page shim has actually broken (prod saw this 2026-09-09: ready +
// catch-up errors, then LOGOUT), and a startup/pairing stall used to hang with
// no watchdog at all (prod 2026-10-05: a pairing code was accepted, logged
// "Loading screen 100%", then sat for 73 minutes because the old watchdog was
// armed only *after* client.initialize() resolved).
//
// One phase-aware supervisor, armed before initialize(), covers both. It only
// ever acts on genuine faults, so a client that is legitimately waiting for a
// human to request a pairing code is never killed. Anything it declares fatal
// notifies the operator first, then exits so systemd brings up a fresh client.
const superviseIntervalMs = 60 * 1000;
const sessionHealthCheckFailLimit = 3;

// A code is requested, then the human walks to their phone and types it. Ten
// minutes is far longer than that walk and far shorter than "stuck forever".
const startupStallTimeoutMs = 10 * 60 * 1000;
const linkStallTimeoutMs = 10 * 60 * 1000;

// getState() stays on a 10-minute cadence so the 3-miss limit keeps meaning
// "~30 minutes of a linked client not answering". The supervisor itself ticks
// every minute so a startup stall is caught inside its 10-minute budget; polling
// a healthy linked client that often would restart a merely slow client.
const sessionHealthCheckIntervalMs = 10 * 60 * 1000;

type ClientPhase =
  | "starting"
  | "awaitingLink"
  | "linking"
  | "ready"
  | "ended";

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
  // Launches Chromium through puppeteer-extra + stealth (fingerprinting
  // mitigation against WhatsApp's server-side session revokes) and hands the
  // running browser to whatsapp-web.js via `puppeteer.browserWSEndpoint`
  // instead of letting wwebjs launch its own. An experiment, not a guarantee:
  // gated by STEALTH_ENABLED (default on, set in providers.ts), easy to flip.
  stealthEnabled?: boolean;
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
  private client: InstanceType<typeof Client>;
  private readonly phoneNumber: string;
  private readonly sendTimeoutMs: number;
  private readonly forwardStatuses: WhatsAppForwardFilter;
  private readonly forwardGroups: WhatsAppForwardFilter;
  private readonly stealthEnabled: boolean;
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
  private healthCheckMisses = 0;
  private lastHealthProbeAt = 0;
  private watchdogTimer?: NodeJS.Timeout;
  private phase: ClientPhase = "starting";
  private phaseEnteredAt = Date.now();
  private relinking = false;
  private strayAsyncErrors: string[] = [];
  private stealthBrowser: InstanceType<typeof import("puppeteer").Browser> | undefined;

  // ponytail: whatsapp-web.js leaves stray promises in flight across a logout
  // (its own inject() re-races in exposeFunctionIfAbsent, and puppeteer throws
  // TargetCloseError when teardown kills the page target). Those used to kill
  // the process, which is why a kicked session looked like a crash. index.ts
  // records them via recordStrayAsyncError() instead; genuine faults are caught
  // by the supervisor below.
  constructor(config: WhatsAppWebChannelConfig) {
    this.phoneNumber = config.phoneNumber;
    this.stealthEnabled = config.stealthEnabled ?? false;
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
    this.client = this.createClient();
  }

  // Extracted so a post-LOGOUT relink can swap in a brand new Client. whatsapp-web.js
  // clients are single-use: the one that saw LOGOUT has a dead socket and re-injects
  // into a page that is going away, so reusing it is what produced the post-logout
  // inject race. A fresh Client is the supported way back.
  private createClient(): InstanceType<typeof Client> {
    return new Client({
      authStrategy: new LocalAuth(),
      webVersion: pinnedWhatsAppWebVersion,
      webVersionCache: {
        type: "local",
        path: pinnedWebVersionsDir,
        strict: true,
      },
      puppeteer: {
        args: browserArgs(),
        protocolTimeout: 120_000,
      },
    });
  }

  // Launch Chromium ourselves through puppeteer-extra + stealth and point
  // whatsapp-web.js at it via browserWSEndpoint. Must run BEFORE
  // client.initialize(): the Client reads this.options.puppeteer at
  // initialize-time (Client.js) and connects when browserWSEndpoint is present,
  // instead of launching its own browser with local args.
  private async launchStealthBrowser(): Promise<void> {
    const extra = addExtra(
      // puppeteer-extra's VanillaPuppeteer requires the ancient
      // createBrowserFetcher that puppeteer 24 dropped; launch/connect are all
      // we use and they exist on the installed module.
      puppeteer as unknown as Parameters<typeof addExtra>[0],
    );
    extra.use(StealthPlugin());
    this.stealthBrowser = await extra.launch({
      headless: true,
      defaultViewport: null,
      userDataDir: stealthSessionDir,
      args: browserArgs(),
    });
    logWhatsApp(
      `Stealth mode active; connected via browserWSEndpoint (${this.stealthBrowser.wsEndpoint()}).`,
    );
    // The Client's runtime options carry the puppeteer config read at
    // initialize(); the public d.ts omits `options`, so cast to it.
    (this.client as unknown as {
      options: { puppeteer?: Record<string, unknown> };
    }).options.puppeteer = {
      browserWSEndpoint: this.stealthBrowser.wsEndpoint(),
      protocolTimeout: 120_000,
    };
  }

  private async closeBrowser(): Promise<void> {
    // Prefer the browser we launched. Otherwise reach the one whatsapp-web.js
    // launched itself: a relink no longer exits the process, so on the default
    // path the old Chromium would otherwise stay alive next to the new one.
    const browser = this.stealthBrowser ?? this.clientBrowser();
    this.stealthBrowser = undefined;
    if (browser) {
      await browser.close().catch(error => {
        logWhatsApp(`Browser close failed: ${formatError(error)}`);
      });
    }
  }

  private clientBrowser(): InstanceType<typeof import("puppeteer").Browser> | undefined {
    try {
      return this.client?.pupPage?.browser();
    } catch {
      // The page target can already be detached mid-teardown, which is the whole
      // point of being here.
      return undefined;
    }
  }

  onMessage(handler: InboundMessageHandler): void {
    this.handler = handler;
    this.catchUpSweep.setForward(handler);
  }

  onGroupInvite(handler: WhatsAppGroupInviteHandler): void {
    this.groupInviteHandler = handler;
  }

  async start(): Promise<void> {
    this.armSupervisor();
    await this.bringUpClient();
  }

  // Arm the supervisor BEFORE initialize(). It used to be armed only after
  // initialize() resolved, which left every startup and pairing stall
  // unsupervised - the 2026-10-05 73-minute hang included.
  private armSupervisor(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      void this.supervise();
    }, superviseIntervalMs);
    this.watchdogTimer.unref?.();
  }

  // Launch a browser, wire listeners, and initialize. Used for the first boot and
  // again for every post-LOGOUT relink.
  private async bringUpClient(): Promise<void> {
    this.setPhase("starting");
    if (this.stealthEnabled) {
      await this.launchStealthBrowser();
    }
    this.attach(this.client);
    logWhatsApp("Initializing client.");

    try {
      await this.client.initialize();
    } catch (error) {
      // A throw here means the client never came up at all. Swallowing it (the old
      // behaviour) left the process "active" with a dead WhatsApp and no retry, so
      // treat it as the fault it is: tell the operator, then let systemd restart.
      await this.failFatal(
        "WhatsApp client failed to start",
        [
          "The WhatsApp client could not initialize and the service is restarting.",
          "If this repeats, the pinned web build or the browser launch is the likely cause.",
          "",
          `Error: ${formatError(error)}`,
          `Time: ${new Date().toISOString()}`,
          ...this.strayAsyncErrorLines(),
        ].join("\n"),
      );
    }
  }

  // All listeners live here so a relink can re-attach them to a fresh Client.
  private attach(client: InstanceType<typeof Client>): void {
    client.on("code", () => {
      this.pairingCodeRequests += 1;
      this.setPhase("linking");
      logWhatsApp(
        `Pairing code requested (#${this.pairingCodeRequests}). Use the authenticated settings UI to view it.`,
      );
    });

    client.on("authenticated", () => {
      this.awaitingLinkLogged = false;
      logWhatsApp("Client authenticated.");
    });

    client.on("auth_failure", message => {
      logWhatsApp(`Authentication failed: ${formatError(message)}`);
    });

    client.on("ready", () => {
      logWhatsApp("Client is ready.");
      this.linked = true;
      this.setPhase("ready");
      this.unlinkedNotified = false;
      this.sendReadyNotification();
      void this.catchUpSweep.runCatchUpIfPending();
    });

    client.on("disconnected", async reason => {
      if (this.sessionEndHandled) return;
      this.sessionEndHandled = true;
      this.catchUpPending = true;
      this.linked = false;
      this.setPhase("ended");
      const reasonText = formatError(reason);
      logWhatsApp(
        `Client disconnected: ${reasonText}. WhatsApp ended the session; the service stays up. Request a pairing code to relink (a fresh client is started for you).`,
      );
      // Deliberately no process.exit() here. A kicked session is a routine event,
      // not a crash: prod restarted the whole service on every LOGOUT, which both
      // looked like a crash and re-hit WhatsApp from a possibly-flagged IP on a
      // timer. WhatsApp revoked the session minutes after linking on 2026-09-16
      // and again on 2026-10-05, so that loop had real cost.
      //
      // The old exit was a band-aid for whatsapp-web.js racing its own inject()
      // after the logout navigation (onQRChangedEvent already exists) and for
      // puppeteer's TargetCloseError during teardown. Both are stray-promise noise
      // now caught by the process-level handlers in index.ts, so exiting is not
      // needed to avoid dying on them.
      await this.notifyError(
        "Message Hub: WhatsApp session disconnected",
        [
          "WhatsApp ended the session (e.g. the server revoked it, or you logged",
          "out from the phone). The service is still running and is waiting for you.",
          "",
          "Request a pairing code to relink; a fresh client is started automatically.",
          "",
          `Reason: ${reasonText}`,
          `Time: ${new Date().toISOString()}`,
          `Stealth: ${this.stealthEnabled ? "enabled" : "disabled"}`,
        ].join("\n"),
      );
      await this.closeBrowser();
    });

    client.on("change_state", state => {
      logWhatsApp(`State changed: ${formatError(state)}`);
    });

    client.on("loading_screen", (percent, message) => {
      logWhatsApp(
        `Loading screen ${formatError(percent)}%: ${formatError(message)}`,
      );
    });

    // whatsapp-web.js re-emits "qr" every ~20s while unlinked. Say so once per unlinked stretch
    // instead of every refresh, so a device waiting to be paired cannot bury real errors in the log.
    client.on("qr", () => {
      if (this.awaitingLinkLogged) return;
      this.awaitingLinkLogged = true;
      // Only claim "awaitingLink" while a link is genuinely outstanding. After a
      // LOGOUT the phase is "ended" and must stay there until a relink starts.
      if (this.phase !== "ended") this.setPhase("awaitingLink");
      logWhatsApp(
        "Waiting to be linked. Nothing further will be logged until you use Request Pairing Code.",
      );
    });

    client.on("message_create", msg => {
      if (!msg.fromMe) return;

      const resolveDelivery = this.deliveryQueue.shift();
      if (!resolveDelivery) return;

      const onAck = (ackMsg: any, ack: number) => {
        if (ackMsg.id._serialized !== msg.id._serialized) return;

        if (ack === 2) {
          resolveDelivery("delivered");
          client.removeListener("message_ack", onAck);
        } else if (ack === -1) {
          resolveDelivery("error");
          client.removeListener("message_ack", onAck);
        }
      };
      client.on("message_ack", onAck);

      setTimeout(() => {
        resolveDelivery("sent");
        client.removeListener("message_ack", onAck);
      }, this.sendTimeoutMs);
    });

    client.on("message", async rawMessage => {
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
  }

  // Phase-aware supervision. Runs every superviseIntervalMs and only declares a
  // fault in states that cannot recover on their own:
  //   starting     - initialize() never resolved
  //   linking      - a code was issued but the client never went ready
  //   ready        - getState() stopped answering or reports non-CONNECTED
  // awaitingLink and ended are left alone on purpose: those are the states where
  // a human is expected to act, and killing them is what made this need babysitting.
  private async supervise(): Promise<void> {
    if (this.phase === "awaitingLink" || this.phase === "ended") return;
    const stalledForMs = Date.now() - this.phaseEnteredAt;

    if (this.phase === "starting" && stalledForMs > startupStallTimeoutMs) {
      await this.failFatal(
        "WhatsApp client startup stalled",
        [
          "The WhatsApp client never finished starting and the service is restarting.",
          "This used to hang silently with no watchdog at all.",
          "",
          `Phase: starting for ${Math.round(stalledForMs / 1000)}s`,
          `Time: ${new Date().toISOString()}`,
          ...this.strayAsyncErrorLines(),
        ].join("\n"),
      );
      return;
    }

    if (this.phase === "linking" && stalledForMs > linkStallTimeoutMs) {
      await this.failFatal(
        "WhatsApp pairing did not complete",
        [
          "A pairing code was issued but the client never became ready, so the",
          "service is restarting. Request a new pairing code once it is back up.",
          "",
          `Phase: linking for ${Math.round(stalledForMs / 1000)}s`,
          `Pairing codes issued: ${this.pairingCodeRequests}`,
          `Time: ${new Date().toISOString()}`,
          ...this.strayAsyncErrorLines(),
        ].join("\n"),
      );
      return;
    }

    if (this.phase === "ready") {
      if (Date.now() - this.lastHealthProbeAt < sessionHealthCheckIntervalMs) {
        return;
      }
      this.lastHealthProbeAt = Date.now();
      await this.checkSessionHealth();
    }
  }

  // The supervisor's original job, kept as-is: whatsapp-web.js can report "ready"
  // and stay connected while its page shim has actually broken (prod 2026-09-09:
  // ready + catch-up errors, then LOGOUT).
  private async checkSessionHealth(): Promise<void> {
    if (!this.linked || this.sessionEndHandled) return;

    try {
      const state = await this.client.getState();
      if (state === "CONNECTED") {
        this.healthCheckMisses = 0;
        return;
      }
      logWhatsApp(`Session health: unexpected state ${state} while linked.`);
    } catch (error) {
      logWhatsApp(`Session health probe failed: ${formatError(error)}`);
    }

    this.healthCheckMisses += 1;
    if (this.healthCheckMisses < sessionHealthCheckFailLimit) return;

    await this.failFatal(
      "Message Hub: WhatsApp client unresponsive",
      [
        "The WhatsApp client stayed linked but stopped responding to health",
        "probes, so the service is restarting to recover.",
        "",
        `Missed ${this.healthCheckMisses} health checks in a row.`,
        `Time: ${new Date().toISOString()}`,
        ...this.strayAsyncErrorLines(),
      ].join("\n"),
    );
  }

  async requestPairingCode(): Promise<string> {
    // A relink after a kick needs a fresh Client; the one that saw LOGOUT is dead
    // and re-injects into a page that is going away. Do it here, on the human's
    // request, rather than on a timer, so a revoked session is not re-dialled
    // against WhatsApp's servers over and over with nobody asking.
    await this.relinkIfEnded();
    logWhatsApp("Manual pairing code request received.");
    return await this.client.requestPairingCode(
      this.phoneNumber,
      true,
      maxSignedIntTimerDelayMs,
    );
  }

  private setPhase(phase: ClientPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.phaseEnteredAt = Date.now();
    if (phase === "ready") this.healthCheckMisses = 0;
    logWhatsApp(`Client phase: ${phase}.`);
  }

  // Record stray async failures instead of letting them kill the process. Public
  // because index.ts owns the process-level handlers and has no business reaching
  // into a WhatsApp adapter's internals to report them.
  recordStrayAsyncError(error: unknown): void {
    const text = formatError(error);
    this.strayAsyncErrors.push(text);
    // Keep the tail only: this is diagnostic context for the next real fault, and
    // an unbounded list would grow for the life of the process.
    if (this.strayAsyncErrors.length > 20) this.strayAsyncErrors.shift();
    logWhatsApp(`Stray async error (not fatal): ${text}`);
  }

  private strayAsyncErrorLines(): string[] {
    if (this.strayAsyncErrors.length === 0) return [];
    return [
      "",
      `Stray async errors since boot (${this.strayAsyncErrors.length}):`,
      ...this.strayAsyncErrors.slice(-5).map(text => `  - ${text}`),
    ];
  }

  // A genuine fault: tell the operator, tidy up, then exit so systemd restarts
  // with a clean process. Never used for an ordinary session kick.
  private async failFatal(subject: string, text: string): Promise<void> {
    this.sessionEndHandled = true;
    logWhatsApp(`${subject}; restarting the service. ${text.replace(/\n+/g, " ")}`);
    await this.notifyError(subject, text);
    await this.closeBrowser();
    process.exit(1);
  }

  // Bring up a replacement client after a LOGOUT, on demand. Guarded so two
  // concurrent pairing-code requests cannot race two Chromium launches.
  private async relinkIfEnded(): Promise<void> {
    if (this.phase !== "ended") return;
    if (this.relinking) {
      throw new Error("A relink is already in progress; retry in a moment");
    }
    this.relinking = true;
    try {
      logWhatsApp("Session ended; starting a fresh WhatsApp client to relink.");
      // Detach the old client before resetting sessionEndHandled below. A dying
      // wwebjs client can still emit a late qr/disconnected while its page
      // closes, and with the guard reset that would mark the *fresh* client
      // ended, re-notify, and close its browser mid-pairing.
      this.client?.removeAllListeners();
      await this.closeBrowser();
      this.client = this.createClient();
      this.sessionEndHandled = false;
      this.awaitingLinkLogged = false;
      this.healthCheckMisses = 0;
      this.readyNotificationSent = false;
      await this.bringUpClient();
    } finally {
      this.relinking = false;
    }
  }

  async sendMessage(message: WhatsAppDirectMessage): Promise<SentMessage> {
    this.ensureLinked();
    const chatId = await this.sendWithContext(
      this.ensureChatForPhoneNumber(message.phoneNumber),
      `Chat lookup for ${message.phoneNumber}`,
    );
    const sent = await this.sendChatMessage({ chatId, text: message.text });
    // ponytail: ensureChatForPhoneNumber may return a @lid-format chatId,
    // but inbound messages arrive as phoneNumber@c.us. Return the @c.us
    // form so callers (thread rotation) store a chatId that matches lookups.
    return { ...sent, chatId: `${message.phoneNumber}@c.us` };
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

    const sent = await this.sendAndTrack(
      chatId,
      this.client.sendMessage(chatId, media, {
        caption: message.text,
      }),
    );
    // ponytail: same @lid → @c.us normalization as sendMessage
    return { ...sent, chatId: `${message.phoneNumber}@c.us` };
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

// LocalAuth's session dir (its hardcoded dataPath './.wwebjs_auth/' + '/session').
// The stealth-launched browser must use the SAME profile dir wwebjs writes the
// session to, or the saved session is silently lost and a re-pair is forced.
// userDataDir is a launch-time flag; puppeteer.connect() ignores it, so the
// manual launch is the only place it can be set (LocalAuth.js sets it in
// options.puppeteer, which is where the not-compatible guard reads it — that
// guard fires only when wwebjs ITSELF launches with args, which this bypasses).
const stealthSessionDir = join(resolve("./.wwebjs_auth"), "session");

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

