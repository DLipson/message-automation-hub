import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Attachment } from "mailparser";
import type { InboundEmail } from "../../domain/email.js";
import type { MediaAttachment } from "../../domain/media.js";
import type { EmailInbox, EmailStatusMarker } from "../../ports/email-inbox.js";

export type ImapEmailInboxConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  checkpointPath?: string;
};

type ImapCheckpoint = { host: string; user: string; mailbox: string; uidValidity: string; lastUid: number };
type FetchedEmail = InboundEmail & { uid: number };
type EmailBatch = { emails: InboundEmail[]; complete(): Promise<void> };

export class ImapEmailInbox implements EmailInbox, EmailStatusMarker {
  constructor(private readonly config: ImapEmailInboxConfig) {}

  async fetchUnread(): Promise<EmailBatch> {
    const client = this.createClient();
    await client.connect();
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
          console.error(`Failed to parse IMAP message UID ${message.uid}: ${formatError(error)}`);
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
    } finally { await client.logout(); }
  }

  async ensureLabels(labels: string[]): Promise<void> {
    const client = this.createClient(); await client.connect();
    try { for (const label of labelsWithParents(labels)) { try { await client.mailboxCreate(label); } catch (error) { if (!isAlreadyExistsError(error)) throw error; } } }
    finally { await client.logout(); }
  }
  async markProcessed(email: InboundEmail): Promise<void> { await this.updateEmail(email, async (client, uid) => { await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); }); }
  async markSent(email: InboundEmail): Promise<void> { await this.updateEmail(email, async (client, uid) => { await client.messageFlagsRemove(uid, ["WA/Failed"], { uid: true, useLabels: true }); await client.messageFlagsAdd(uid, ["WA/Sent"], { uid: true, useLabels: true }); }); }
  async markFailed(email: InboundEmail): Promise<void> { await this.updateEmail(email, async (client, uid) => { await client.messageFlagsRemove(uid, ["WA/Sent"], { uid: true, useLabels: true }); await client.messageFlagsAdd(uid, ["WA/Failed"], { uid: true, useLabels: true }); }); }

  private async updateEmail(email: InboundEmail, update: (client: ImapFlow, uid: number) => Promise<void>): Promise<void> {
    const uid = Number(email.id); if (!Number.isInteger(uid)) throw new Error(`Cannot update email without numeric IMAP uid: ${email.id}`);
    const client = this.createClient(); await client.connect();
    try { await client.mailboxOpen("INBOX"); await update(client, uid); } finally { await client.logout(); }
  }
  private async readCheckpoint(): Promise<ImapCheckpoint | null> {
    if (!this.config.checkpointPath) return null;
    try {
      const value = JSON.parse(await readFile(this.config.checkpointPath, "utf8")) as Partial<ImapCheckpoint>;
      const lastUid = value.lastUid;
      if (typeof value.host !== "string" || typeof value.user !== "string" || value.mailbox !== "INBOX" || typeof value.uidValidity !== "string" || typeof lastUid !== "number" || !Number.isInteger(lastUid) || lastUid < 0) throw new Error("Invalid IMAP checkpoint contents");
      return value as ImapCheckpoint;
    } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
  }
  private async writeCheckpoint(checkpoint: ImapCheckpoint): Promise<void> {
    if (!this.config.checkpointPath) return;
    await mkdir(dirname(this.config.checkpointPath), { recursive: true });
    const tempPath = `${this.config.checkpointPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, this.config.checkpointPath);
  }
  private createClient(): ImapFlow {
    const client = new ImapFlow({ host: this.config.host, port: this.config.port, secure: this.config.secure, auth: { user: this.config.user, pass: this.config.pass }, logger: false });
    client.on("error", error => console.error(`IMAP client error: ${formatError(error)}`)); return client;
  }
}

function toMediaAttachment(attachment: Attachment): MediaAttachment { return { content: attachment.content, contentType: attachment.contentType, ...(attachment.filename ? { filename: attachment.filename } : {}) }; }
function referencesFor(references: string[] | string | undefined): string[] { return !references ? [] : Array.isArray(references) ? references : [references]; }
function labelsWithParents(labels: string[]): string[] { return [...new Set(labels.flatMap(label => { const parts = label.split("/"); return parts.map((_, index) => parts.slice(0, index + 1).join("/")); }))]; }
function isAlreadyExistsError(error: unknown): boolean { return error instanceof Error && /exist/i.test(error.message); }
function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
