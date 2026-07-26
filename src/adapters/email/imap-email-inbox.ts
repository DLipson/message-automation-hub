import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Attachment } from "mailparser";
import type { InboundEmail } from "../../domain/email.js";
import { errorMessage, isFileMissing } from "../../errors.js";
import type { MediaAttachment } from "../../domain/media.js";
import type {
  EmailInbox,
  EmailLabeler,
  EmailStatusMarker,
} from "../../ports/email-inbox.js";

export type ImapEmailInboxConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  checkpointPath?: string;
};

// ponytail: imapflow only exports ImapFlow at runtime (no AuthenticationFailure class), so duck-type the error.
// Its `authenticationFailed` flag is set for ANY failure of the AUTHENTICATE command, including transient
// ones like "Too many simultaneous connections", so only the AUTHENTICATIONFAILED response code is permanent.
export const isAuthenticationFailure = (error: unknown): boolean =>
  (error as { serverResponseCode?: string } | null)?.serverResponseCode === "AUTHENTICATIONFAILED";

type ImapCheckpoint ={ host: string; user: string; mailbox: string; uidValidity: string; lastUid: number };
type FetchedEmail = InboundEmail & { uid: number };
type EmailBatch = { emails: InboundEmail[]; complete(): Promise<void> };

export class ImapEmailInbox implements EmailInbox, EmailLabeler, EmailStatusMarker {
  constructor(private readonly config: ImapEmailInboxConfig) {}

  async fetchUnread(): Promise<EmailBatch> {
    const client = await this.connectClient();
    try {
      const mailbox = await client.mailboxOpen("INBOX");
      const uidValidity = String(mailbox.uidValidity);
      const upperUid = mailbox.uidNext - 1;
      const state = await this.readCheckpoint();
      if (!state || state.host !== this.config.host || state.user !== this.config.user || state.mailbox !== "INBOX" || state.uidValidity !== uidValidity) {
        await this.writeCheckpoint({ host: this.config.host, user: this.config.user, mailbox: "INBOX", uidValidity, lastUid: upperUid });
        console.log(`IMAP checkpoint initialized at UID ${upperUid}.`);
        return { emails: [], complete: async () => {} };
      }
      const startUid = state.lastUid + 1;
      if (startUid > upperUid) {
        return { emails: [], complete: async () => { await this.writeCheckpoint({ ...state, lastUid: upperUid }); } };
      }
      const found = await client.search({ seen: false, uid: `${startUid}:${upperUid}` }, { uid: true });
      const selectedUids = (found === false ? [] : found).sort((a, b) => a - b).slice(0, 25);
      const emails: FetchedEmail[] = [];
      for await (const message of client.fetch(selectedUids, { envelope: true, source: true, uid: true }, { uid: true })) {
        if (!message.source || message.uid == null) continue;
        let parsed;
        try { parsed = await simpleParser(message.source); } catch (error) {
          console.error(`Failed to parse IMAP message UID ${message.uid}: ${errorMessage(error)}`);
          continue;
        }
        const attachments = parsed.attachments.map(toMediaAttachment);
        const references = referencesFor(parsed.references);
        const email: FetchedEmail = {
          id: String(message.uid), uid: message.uid,
          subject: parsed.subject ?? message.envelope?.subject ?? "",
          text: parsed.text ?? "", receivedAt: parsed.date ?? new Date(),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
          ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
          ...(references.length > 0 ? { references } : {}),
        };
        if (parsed.from?.text) email.from = parsed.from.text;
        emails.push(email);
      }
      const lastFetchedUid = selectedUids.at(-1) ?? upperUid;
      return { emails, complete: async () => { await this.writeCheckpoint({ ...state, lastUid: lastFetchedUid }); } };
    } finally { try { await client.logout(); } catch { /* connection may have dropped */ } }
  }

  async ensureLabels(labels: string[]): Promise<void> {
    const client = await this.connectClient();
    try { for (const label of labelsWithParents(labels)) { try { await client.mailboxCreate(label); } catch (error) { if (!isAlreadyExistsError(error)) throw error; } } }
    finally { try { await client.logout(); } catch { /* connection may have dropped */ } }
  }
  async markProcessed(email: InboundEmail): Promise<void> { await this.updateEmail(email, async (client, uid) => { await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); }); }
  async markSent(email: InboundEmail): Promise<void> { await this.updateEmail(email, async (client, uid) => { await client.messageFlagsRemove(uid, ["WA/Failed"], { uid: true, useLabels: true }); await client.messageFlagsAdd(uid, ["WA/Sent"], { uid: true, useLabels: true }); }); }
  async markDelivered(email: InboundEmail): Promise<void> { await this.updateEmail(email, async (client, uid) => { await client.messageFlagsRemove(uid, ["WA/Sent", "WA/Failed"], { uid: true, useLabels: true }); await client.messageFlagsAdd(uid, ["WA/Delivered"], { uid: true, useLabels: true }); }); }
  async markFailed(email: InboundEmail): Promise<void> { await this.updateEmail(email, async (client, uid) => { await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); await client.messageFlagsRemove(uid, ["WA/Sent", "WA/Delivered"], { uid: true, useLabels: true }); await client.messageFlagsAdd(uid, ["WA/Failed"], { uid: true, useLabels: true }); }); }

  private async updateEmail(email: InboundEmail, update: (client: ImapFlow, uid: number) => Promise<void>): Promise<void> {
    const uid = Number(email.id); if (!Number.isInteger(uid)) throw new Error(`Cannot update email without numeric IMAP uid: ${email.id}`);
    const client = await this.connectClient();
    try { await client.mailboxOpen("INBOX"); await update(client, uid); } finally { try { await client.logout(); } catch { /* connection may have dropped */ } }
  }
  private async readCheckpoint(): Promise<ImapCheckpoint | null> {
    if (!this.config.checkpointPath) return null;
    try {
      const value = JSON.parse(await readFile(this.config.checkpointPath, "utf8")) as Partial<ImapCheckpoint>;
      const lastUid = value.lastUid;
      if (typeof value.host !== "string" || typeof value.user !== "string" || value.mailbox !== "INBOX" || typeof value.uidValidity !== "string" || typeof lastUid !== "number" || !Number.isInteger(lastUid) || lastUid < 0) throw new Error("Invalid IMAP checkpoint contents");
      return value as ImapCheckpoint;
    } catch (error) { if (isFileMissing(error)) return null; throw error; }
  }
  private async writeCheckpoint(checkpoint: ImapCheckpoint): Promise<void> {
    if (!this.config.checkpointPath) return;
    await mkdir(dirname(this.config.checkpointPath), { recursive: true });
    const tempPath = `${this.config.checkpointPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.config.checkpointPath);
  }
  async watchNewMail(onNewMail: () => void): Promise<() => Promise<void>> {
    let stopped = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let currentClient: ImapFlow | undefined;
    let firstConnectResolve: (() => void) | undefined;
    const firstConnected = new Promise<void>(resolve => { firstConnectResolve = resolve; });

    const scheduleCallback = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (!stopped) onNewMail();
      }, 1000);
    };

    const run = async () => {
      let retryDelay = 5000;
      while (!stopped) {
        const client = new ImapFlow({
          host: this.config.host, port: this.config.port, secure: this.config.secure,
          auth: { user: this.config.user, pass: this.config.pass },
          maxIdleTime: 25 * 60 * 1000,
          logger: false,
        });
        currentClient = client;
        client.on("error", error => console.error(`IMAP watcher error: ${errorMessage(error)}`));
        try {
          await client.connect();
          await client.mailboxOpen("INBOX");
          client.on("exists", scheduleCallback);
          firstConnectResolve?.();
          firstConnectResolve = undefined;
          await client.idle();
          retryDelay = 5000;
        } catch (error) {
          console.error(`IMAP watcher error: ${errorMessage(error)}`);
          firstConnectResolve?.();
          firstConnectResolve = undefined;
          if (isAuthenticationFailure(error)) {
            console.error(`IMAP watcher: authentication failed (${errorMessage(error)}). Giving up. Fallback poll will continue.`);
            stopped = true;
            break;
          }
        }
        client.off("exists", scheduleCallback);
        client.removeAllListeners("error");
        if (!stopped) {
          await sleep(retryDelay);
          retryDelay = Math.min(retryDelay * 2, 300_000);
        }
      }
    };

    const loopPromise = run();
    await firstConnected;

    return async () => {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (currentClient) {
        try { await currentClient.logout(); } catch { /* ignore */ }
      }
      await loopPromise;
    };
  }

  // ponytail: one connection per operation, so a restart storm can trip the server's simultaneous-connection
  // limit. Retry transient connect failures rather than letting them kill startup. Pool connections if it recurs.
  private async connectClient(): Promise<ImapFlow> {
    let delay = 5000;
    for (let attempt = 1; ; attempt++) {
      const client = this.createClient();
      try {
        await client.connect();
        return client;
      } catch (error) {
        if (attempt >= 5 || isAuthenticationFailure(error)) throw error;
        console.error(`IMAP connect failed (attempt ${attempt}): ${errorMessage(error)}. Retrying in ${delay / 1000}s.`);
        await sleep(delay);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  private createClient(): ImapFlow {
    const client = new ImapFlow({ host: this.config.host, port: this.config.port, secure: this.config.secure, auth: { user: this.config.user, pass: this.config.pass }, logger: false });
    client.on("error", error => console.error(`IMAP client error: ${errorMessage(error)}`)); return client;
  }
}

function toMediaAttachment(attachment: Attachment): MediaAttachment { return { content: attachment.content, contentType: attachment.contentType, ...(attachment.filename ? { filename: attachment.filename } : {}) }; }
function referencesFor(references: string[] | string | undefined): string[] { return !references ? [] : Array.isArray(references) ? references : [references]; }
function labelsWithParents(labels: string[]): string[] { return [...new Set(labels.flatMap(label => { const parts = label.split("/"); return parts.map((_, index) => parts.slice(0, index + 1).join("/")); }))]; }
function isAlreadyExistsError(error: unknown): boolean { return error instanceof Error && /exist/i.test(error.message); }
