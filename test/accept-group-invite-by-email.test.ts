import { describe, expect, it } from "vitest";
import type { InboundEmail } from "../src/domain/email.js";
import type { AppLogger } from "../src/ports/app-logger.js";
import type { EmailMessage, EmailSender } from "../src/ports/email-sender.js";
import type {
  SentMessage,
  WhatsAppChatSender,
  WhatsAppGroupInviteV4,
} from "../src/ports/whatsapp-sender.js";
import { AcceptGroupInviteByEmail } from "../src/use-cases/accept-group-invite-by-email.js";
import type {
  PendingGroupInvite,
  PendingGroupInviteDetails,
  PendingGroupInviteStore,
} from "../src/use-cases/pending-group-invite-store.js";
import {
  tokenFromSubject,
  type WhatsAppEmailThread,
  type WhatsAppEmailThreadStore,
} from "../src/use-cases/whatsapp-email-thread-store.js";
import { FakeEmailInbox } from "./fakes/fake-email-inbox.js";

class FakeWhatsApp implements WhatsAppChatSender {
  readonly accepted: string[] = [];
  readonly acceptedV4: WhatsAppGroupInviteV4[] = [];

  constructor(private readonly error?: Error) {}

  async sendChatMessage(): Promise<SentMessage> {
    throw new Error("unused");
  }

  async acceptInvite(inviteCode: string): Promise<string> {
    if (this.error) {
      throw this.error;
    }

    this.accepted.push(inviteCode);
    return `group-${inviteCode}@g.us`;
  }

  async acceptGroupV4Invite(inviteV4: WhatsAppGroupInviteV4): Promise<{ status: number }> {
    if (this.error) {
      throw this.error;
    }

    this.acceptedV4.push(inviteV4);
    return { status: 200 };
  }
}

class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

class FakePendingStore implements PendingGroupInviteStore {
  readonly invites = new Map<string, PendingGroupInviteDetails>();

  async put(token: string, invite: PendingGroupInviteDetails): Promise<void> {
    this.invites.set(token, invite);
  }

  async findByToken(token: string): Promise<PendingGroupInvite | null> {
    const invite = this.invites.get(token);
    return invite === undefined ? null : { token, ...invite };
  }

  async remove(token: string): Promise<void> {
    this.invites.delete(token);
  }
}

class FakeThreadStore implements WhatsAppEmailThreadStore {
  constructor(private readonly thread: WhatsAppEmailThread) {}

  async getOrCreate(): Promise<WhatsAppEmailThread> {
    return this.thread;
  }

  async findByToken(token: string): Promise<WhatsAppEmailThread | null> {
    return token === this.thread.token ? this.thread : null;
  }

  async findByMessageId(messageId: string): Promise<WhatsAppEmailThread | null> {
    return messageId === this.thread.rootMessageId ? this.thread : null;
  }
}

const silentLogger: AppLogger = { info() {} };

const thread: WhatsAppEmailThread = {
  token: "abc123",
  chatId: "127513921597547@lid",
  subject: "WhatsApp: Alice [wa:abc123]",
  rootMessageId: "<wa.abc123@message-automation-hub.local>",
};

const inviteV4: WhatsAppGroupInviteV4 = {
  inviteCode: "V4CODE",
  inviteCodeExp: 1780000000,
  groupId: "120363000000000001@g.us",
  groupName: "Test Group",
  fromId: "12025550108@c.us",
  toId: "12025550108@lid",
};

function handlerFor(options: {
  whatsapp?: FakeWhatsApp;
  pending?: FakePendingStore;
  threads?: WhatsAppEmailThreadStore;
} = {}) {
  const inbox = new FakeEmailInbox();
  const sender = new FakeEmailSender();
  const handler = new AcceptGroupInviteByEmail(
    inbox,
    sender,
    options.threads ?? new FakeThreadStore(thread),
    options.pending ?? new FakePendingStore(),
    options.whatsapp ?? new FakeWhatsApp(),
    {
      ownerEmail: "owner@example.com",
      from: "hub@example.com",
      messageIdDomain: "message-automation-hub.local",
    },
    silentLogger,
  );
  return { inbox, sender, handler };
}

function email(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    id: "email-1",
    from: "owner@example.com",
    subject: "Group invite",
    text: "Join us! https://chat.whatsapp.com/AbC123-xy",
    receivedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("AcceptGroupInviteByEmail", () => {
  it("records a direct-email invite and emails the owner a confirmation", async () => {
    const { inbox, sender, handler } = handlerFor();
    const invite = email();
    const result = await handler.handle(invite, { sentWhatsAppImage: false });

    expect(result).toBe(true);
    expect(sender.sent).toHaveLength(1);
    const confirmation = sender.sent[0]!;
    expect(confirmation.to).toBe("owner@example.com");
    const token = tokenFromSubject(confirmation.subject);
    expect(token).toBeTruthy();
    expect(confirmation.text).toContain("https://chat.whatsapp.com/AbC123-xy");
    expect(confirmation.text).toContain("accept");
    expect(confirmation.messageId).toBe(`<wa.${token}@message-automation-hub.local>`);
    expect(inbox.processed).toEqual([invite]);
  });

  it("accepts a pending invite when the owner replies 'accept'", async () => {
    const pending = new FakePendingStore();
    await pending.put("abc123", { inviteCode: "AbC123-xy" });
    const whatsapp = new FakeWhatsApp();
    const { inbox, sender, handler } = handlerFor({ pending, whatsapp });
    const reply = email({
      subject: "Re: Group invite detected [wa:abc123]",
      text: "accept",
    });

    const result = await handler.handle(reply, { sentWhatsAppImage: false });

    expect(result).toBe(true);
    expect(whatsapp.accepted).toEqual(["AbC123-xy"]);
    expect(pending.invites.has("abc123")).toBe(false);
    expect(sender.sent[0]?.subject).toContain("accepted");
    expect(sender.sent[0]?.text).toContain("group-AbC123-xy@g.us");
    expect(inbox.processed).toEqual([reply]);
  });

  it("accepts an invite reply matched by references", async () => {
    const pending = new FakePendingStore();
    await pending.put("abc123", { inviteCode: "AbC123-xy" });
    const whatsapp = new FakeWhatsApp();
    const { inbox, sender, handler } = handlerFor({ pending, whatsapp });
    const reply = email({
      subject: "Re: WhatsApp: Alice",
      text: "accept",
      inReplyTo: "<wa.abc123.abc@message-automation-hub.local>",
    });

    await handler.handle(reply, { sentWhatsAppImage: false });

    expect(whatsapp.accepted).toEqual(["AbC123-xy"]);
    expect(pending.invites.has("abc123")).toBe(false);
    expect(sender.sent[0]?.subject).toContain("accepted");
    expect(inbox.processed).toEqual([reply]);
  });

  it("keeps the invite pending on a non-accept reply", async () => {
    const pending = new FakePendingStore();
    await pending.put("abc123", { inviteCode: "AbC123-xy" });
    const whatsapp = new FakeWhatsApp();
    const { inbox, sender, handler } = handlerFor({ pending, whatsapp });
    const reply = email({
      subject: "Re: Group invite detected [wa:abc123]",
      text: "no thanks",
    });

    const result = await handler.handle(reply, { sentWhatsAppImage: false });

    expect(result).toBe(true);
    expect(whatsapp.accepted).toEqual([]);
    expect(pending.invites.get("abc123")).toEqual({ inviteCode: "AbC123-xy" });
    expect(sender.sent[0]?.subject).toContain("pending");
    expect(sender.sent[0]?.text).toContain("https://chat.whatsapp.com/AbC123-xy");
    expect(inbox.processed).toEqual([reply]);
  });

  it("ignores replies from non-owners", async () => {
    const pending = new FakePendingStore();
    await pending.put("abc123", { inviteCode: "AbC123-xy" });
    const whatsapp = new FakeWhatsApp();
    const { inbox, sender, handler } = handlerFor({ pending, whatsapp });
    const reply = email({
      from: "attacker@example.com",
      subject: "Re: Group invite detected [wa:abc123]",
      text: "accept",
    });

    const result = await handler.handle(reply, { sentWhatsAppImage: false });

    expect(result).toBe(true);
    expect(whatsapp.accepted).toEqual([]);
    expect(sender.sent).toEqual([]);
    expect(pending.invites.has("abc123")).toBe(true);
    expect(inbox.processed).toEqual([reply]);
  });

  it("keeps the invite pending when accepting fails", async () => {
    const pending = new FakePendingStore();
    await pending.put("abc123", { inviteCode: "AbC123-xy" });
    const whatsapp = new FakeWhatsApp(new Error("invite expired"));
    const { inbox, sender, handler } = handlerFor({ pending, whatsapp });
    const reply = email({
      subject: "Re: Group invite detected [wa:abc123]",
      text: "accept",
    });

    const result = await handler.handle(reply, { sentWhatsAppImage: false });

    expect(result).toBe(true);
    expect(whatsapp.accepted).toEqual([]);
    expect(pending.invites.get("abc123")).toEqual({ inviteCode: "AbC123-xy" });
    expect(sender.sent[0]?.subject).toContain("could not be accepted");
    expect(sender.sent[0]?.text).toContain("invite expired");
    expect(inbox.processed).toEqual([reply]);
  });

  it("records an invite forwarded from a WhatsApp thread under the thread token", async () => {
    const { inbox, sender, handler } = handlerFor();
    const forwarded: InboundEmail = {
      id: "email-1",
      subject: "WhatsApp: Alice [wa:abc123]",
      text: "Here is the group: https://chat.whatsapp.com/AbC123-xy",
      receivedAt: new Date("2026-01-01T00:00:00Z"),
      messageId: "<wa.abc123.abc@message-automation-hub.local>",
      inReplyTo: thread.rootMessageId,
      references: [thread.rootMessageId],
    };

    const result = await handler.handle(forwarded, { sentWhatsAppImage: false });

    expect(result).toBe(true);
    expect(sender.sent[0]?.subject).toContain("[wa:abc123]");
    expect(sender.sent[0]?.messageId).toBe(thread.rootMessageId);
    expect(inbox.processed).toEqual([forwarded]);
  });

  it("ignores emails without an invite link or pending token", async () => {
    const { inbox, sender, handler } = handlerFor();
    const unrelated = email({
      subject: "Re: WhatsApp: Alice [wa:abc123]",
      text: "just chatting",
    });

    const result = await handler.handle(unrelated, { sentWhatsAppImage: false });

    expect(result).toBe(false);
    expect(sender.sent).toEqual([]);
    expect(inbox.processed).toEqual([]);
  });

  it("records a card invite and emails the owner a confirmation", async () => {
    const { sender, handler } = handlerFor();
    const token = await handler.handleCardInvite(
      inviteV4,
      "12025550108@c.us",
      "Alice (12025550108@c.us)",
    );

    expect(token).toBe("abc123");
    expect(sender.sent).toHaveLength(1);
    const confirmation = sender.sent[0]!;
    expect(confirmation.to).toBe("owner@example.com");
    expect(confirmation.subject).toContain("[wa:abc123]");
    expect(confirmation.text).toContain("Test Group");
    expect(confirmation.text).toContain("Alice (12025550108@c.us)");
    expect(confirmation.text).toContain("accept");
    expect(confirmation.messageId).toBe(thread.rootMessageId);
  });

  it("accepts a card invite when the owner replies 'accept'", async () => {
    const pending = new FakePendingStore();
    await pending.put("abc123", { inviteV4 });
    const whatsapp = new FakeWhatsApp();
    const { inbox, sender, handler } = handlerFor({ pending, whatsapp });
    const reply = email({
      subject: "Re: Group invite detected [wa:abc123]",
      text: "accept",
    });

    const result = await handler.handle(reply, { sentWhatsAppImage: false });

    expect(result).toBe(true);
    expect(whatsapp.acceptedV4).toEqual([inviteV4]);
    expect(pending.invites.has("abc123")).toBe(false);
    expect(sender.sent[0]?.subject).toContain("accepted");
    expect(sender.sent[0]?.text).toContain("120363000000000001@g.us");
    expect(inbox.processed).toEqual([reply]);
  });

  it("keeps a card invite pending when accepting fails", async () => {
    const pending = new FakePendingStore();
    await pending.put("abc123", { inviteV4 });
    const whatsapp = new FakeWhatsApp(new Error("expired invite code"));
    const { inbox, sender, handler } = handlerFor({ pending, whatsapp });
    const reply = email({
      subject: "Re: Group invite detected [wa:abc123]",
      text: "accept",
    });

    const result = await handler.handle(reply, { sentWhatsAppImage: false });

    expect(result).toBe(true);
    expect(whatsapp.acceptedV4).toEqual([]);
    expect(pending.invites.get("abc123")).toEqual({ inviteV4 });
    expect(sender.sent[0]?.subject).toContain("could not be accepted");
    expect(sender.sent[0]?.text).toContain("expired invite code");
    expect(sender.sent[0]?.text).toContain("Test Group");
    expect(inbox.processed).toEqual([reply]);
  });

  it("ignores card-invite accept replies from non-owners", async () => {
    const pending = new FakePendingStore();
    await pending.put("abc123", { inviteV4 });
    const whatsapp = new FakeWhatsApp();
    const { inbox, sender, handler } = handlerFor({ pending, whatsapp });
    const reply = email({
      from: "attacker@example.com",
      subject: "Re: Group invite detected [wa:abc123]",
      text: "accept",
    });

    const result = await handler.handle(reply, { sentWhatsAppImage: false });

    expect(result).toBe(true);
    expect(whatsapp.acceptedV4).toEqual([]);
    expect(sender.sent).toEqual([]);
    expect(pending.invites.has("abc123")).toBe(true);
    expect(inbox.processed).toEqual([reply]);
  });
});
