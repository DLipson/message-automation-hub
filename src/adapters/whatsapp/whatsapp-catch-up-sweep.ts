import type { Chat } from "whatsapp-web.js";
import { formatError } from "../../errors.js";
import type { InboundMessage } from "../../domain/message.js";
import type {
  WhatsAppGroupInviteV4,
} from "../../ports/whatsapp-sender.js";
import type { CatchUpState } from "./json-whatsapp-catch-up-store.js";

export type RawWhatsAppMessage = {
  id: { _serialized: string; "$1"?: string };
  from: string;
  author?: string;
  body: string;
  timestamp: number;
  hasMedia?: boolean;
  hasQuotedMsg?: boolean;
  type?: string;
  inviteV4?: WhatsAppGroupInviteV4;
  downloadMedia?: () => Promise<RawWhatsAppMedia | undefined>;
  getQuotedMessage?: () => Promise<RawWhatsAppMessage>;
  _data?: { notifyName?: string };
};

type RawWhatsAppMedia = {
  mimetype: string;
  data: string;
  filename?: string | null;
};

// ponytail: WhatsApp Web renames this field without notice (_serialized -> $1, July 2026).
// Every read of a message's serialized id goes through here, so the next rename is one edit.
export function serializedIdOf(message: RawWhatsAppMessage): string | undefined {
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

export function messageIdFor(message: RawWhatsAppMessage): string {
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

export function logWhatsApp(message: string): void {
  console.log(`[${new Date().toISOString()}] WhatsApp ${message}`);
}

// The shared handle on the catch-up watermark. BOTH the live-message path and the
// sweep mutate the same CatchUpState object, so a live watermark and a sweep
// watermark cannot diverge and silently replay messages. The channel owns the
// object (it does the lazy load); the sweep only reads/mutates through this ref.
export interface CatchUpStateRef {
  get(): CatchUpState | null;
  set(state: CatchUpState): void;
}

export type CatchUpSweepDeps = {
  store?: { load(): Promise<CatchUpState>; save(state: CatchUpState): Promise<void> } | undefined;
  chatLimit?: number | undefined;
  messageLimitPerChat?: number | undefined;
  getChats: () => Promise<Chat[]>;
  toInboundMessage: (message: RawWhatsAppMessage) => Promise<InboundMessage>;
  shouldHandle: (message: RawWhatsAppMessage) => boolean;
  notifyError: (subject: string, text: string) => Promise<void>;
  serializedIdOf: (message: RawWhatsAppMessage) => string | undefined;
  messageIdFor: (message: RawWhatsAppMessage) => string;
  log: (message: string) => void;
  stateRef: CatchUpStateRef;
};

export class CatchUpSweep {
  private inFlight = false;
  private forward?: (inbound: InboundMessage) => Promise<void>;

  constructor(private readonly deps: CatchUpSweepDeps) {}

  // The channel attaches its inbound handler here (it is mounted after the sweep
  // is constructed); the sweep never forwards while no handler is listening.
  setForward(handler: (inbound: InboundMessage) => Promise<void>): void {
    this.forward = handler;
  }

  // Runs after the first `ready` and again after any `disconnected` + `ready`.
  // Sweeps the chats WhatsApp Web has loaded and forwards messages newer than the
  // last one we already handled, so an offline window (crash, logout) is not lost.
  // Idempotent via the watermark: the 8x `ready` re-sync storm finds nothing new.
  async runCatchUpIfPending(): Promise<void> {
    const { store } = this.deps;
    if (this.inFlight) return;
    if (!store || !this.forward) return;

    this.inFlight = true;
    try {
      let state = this.deps.stateRef.get();
      if (!state) {
        state = await store.load();
        this.deps.stateRef.set(state);
      }
      if (!state.initialized) {
        state.initialized = true;
        state.baseline = Math.floor(Date.now() / 1000);
        await store.save(state);
        this.deps.log(
          "Recorded catch-up baseline; not forwarding pre-existing history.",
        );
        return;
      }
      if (Object.keys(state.chats).length === 0) return;
      await this.sweepForMissedMessages(state);
    } catch (error) {
      const errorText = formatError(error);
      this.deps.log(`Catch-up scan failed: ${errorText}`);
      // ponytail: a failed sweep used to log only and silently drop the offline
      // window's messages (seen 2026-09-10: 3 chat-list attempts failed, nobody
      // knew). Surface it so a missed catch-up is never invisible again.
      await this.deps.notifyError(
        "WhatsApp catch-up scan failed",
        [
          "Missed messages were not replayed because the chat list could not be read.",
          "",
          `Error: ${errorText}`,
        ].join("\n"),
      );
    } finally {
      this.inFlight = false;
    }
  }

  // Advances the persisted catch-up watermark after a message is forwarded.
  // Also called from the live-message path; it must see the SAME shared state the
  // sweep lazily loads, or live and sweep watermarks diverge and messages replay.
  trackWatermark(chatId: string | undefined, timestamp: number): void {
    if (!this.deps.store) return;
    if (!chatId) return;
    const state = this.deps.stateRef.get();
    if (!state || !state.initialized) return;
    const existing = state.chats[chatId] ?? 0;
    if (timestamp <= existing) return;
    state.chats[chatId] = timestamp;
    void this.deps.store.save(state).catch(error => {
      this.deps.log(`Failed to persist catch-up watermark: ${formatError(error)}`);
    });
  }

  private async sweepForMissedMessages(state: CatchUpState): Promise<void> {
    const chatLimit = this.deps.chatLimit ?? 50;
    const messageLimit = this.deps.messageLimitPerChat ?? 50;
    const watermarks = Object.values(state.chats);
    // A chat with no watermark yet starts from the catch-up baseline (or the oldest
    // watermark on stores written before `baseline` existed), so a first-contact
    // message during an offline/stuck window is still recovered.
    const startingFor = (chatId: string): number =>
      state.chats[chatId] ?? state.baseline
        ?? (watermarks.length > 0 ? Math.min(...watermarks) : 0);

    const chats = await this.getChatsWithRetry();
    for (const chat of chats.slice(0, chatLimit)) {
      const rawId = chat.id as unknown as RawWhatsAppMessage;
      const chatId = this.deps.serializedIdOf(rawId);
      if (!chatId) continue;
      const starting = startingFor(chatId);
      const lastTs = chat.lastMessage?.timestamp;
      if (lastTs !== undefined && lastTs <= starting) continue;

      try {
        const messages = await chat.fetchMessages({ limit: messageLimit });
        const candidates = messages.filter(message =>
          !message.fromMe &&
          message.timestamp > starting &&
          this.deps.shouldHandle(message as unknown as RawWhatsAppMessage),
        );

        // Advance the watermark to whatever the page has loaded so a second sweep
        // (or a concurrent live message) does not re-forward it.
        const newest = messages[messages.length - 1]?.timestamp;
        if (newest !== undefined && newest > starting) {
          state.chats[chatId] = newest;
        }

        for (const message of candidates) {
          try {
            const inbound = await this.deps.toInboundMessage(
              message as unknown as RawWhatsAppMessage,
            );
            await this.forward!(inbound);
            this.deps.log(
              `Catch-up forwarded message ${this.deps.messageIdFor(message as unknown as RawWhatsAppMessage)} from ${chatId}`,
            );
            const ts = message.timestamp;
            if (ts > (state.chats[chatId] ?? 0)) {
              state.chats[chatId] = ts;
            }
          } catch (error) {
            const msgId = this.deps.messageIdFor(message as unknown as RawWhatsAppMessage);
            const errorText = formatError(error);
            this.deps.log(`Catch-up failed for message ${msgId}: ${errorText}`);
            await this.deps.notifyError(
              "WhatsApp catch-up message failed",
              `Message ID: ${msgId}\nChat: ${chatId}\nTime: ${new Date(message.timestamp * 1000).toISOString()}\n\nError:\n${errorText}`,
            );
          }
        }

        await this.deps.store!.save(state);
      } catch (error) {
        const errorText = formatError(error);
        this.deps.log(`Catch-up sweep failed for chat ${chatId}: ${errorText}`);
        await this.deps.notifyError(
          "WhatsApp catch-up sweep failed",
          `Chat: ${chatId}\n\nError:\n${errorText}`,
        );
      }
    }
  }

  // ponytail: the sweep runs ~seconds after `ready`, while the page is still
  // syncing chats, so getChats()'s page evaluate can throw (seen 2026-08-17 as
  // "Catch-up scan failed: r: r"). That day 3 attempts with 5s delays were
  // enough; on a fresh re-pair the page needed ~a minute (seen 2026-09-10 all 3
  // tries failing). Retry with a longer budget and backoff instead of giving up.
  private async getChatsWithRetry(): Promise<Chat[]> {
    const deadlineMs = Date.now() + 120_000;
    let attempt = 1;
    let lastError: unknown;

    while (Date.now() < deadlineMs) {
      try {
        return await this.deps.getChats();
      } catch (error) {
        lastError = error;
        const delayMs = Math.min(5000 * attempt, 30_000);
        this.deps.log(
          `Catch-up chat list attempt ${attempt} failed, retrying in ${Math.round(delayMs / 1000)}s: ${formatError(error)}`,
        );
        attempt += 1;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }
}
