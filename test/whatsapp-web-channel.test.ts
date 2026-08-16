import { afterEach, describe, expect, it, vi } from "vitest";

const whatsappMock = vi.hoisted(() => {
  const clients: FakeClient[] = [];

  class FakeClient {
    readonly handlers = new Map<string, (...args: unknown[]) => unknown>();
    readonly initialize = vi.fn(async () => {});
    readonly requestPairingCode = vi.fn(async () => "123456");
    readonly getNumberId = vi.fn(async () => ({ _serialized: "12025550108@c.us" }));
    readonly sendMessage = vi.fn(async () => ({ id: "sent" }));

    constructor() {
      clients.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => unknown): this {
      this.handlers.set(event, handler);
      return this;
    }
  }

  class FakeLocalAuth {}
  class FakeMessageMedia {}

  return { clients, FakeClient, FakeLocalAuth, FakeMessageMedia };
});

vi.mock("whatsapp-web.js", () => ({
  default: {
    Client: whatsappMock.FakeClient,
    LocalAuth: whatsappMock.FakeLocalAuth,
    MessageMedia: whatsappMock.FakeMessageMedia,
  },
}));

import type { EmailMessage, EmailSender } from "../src/ports/email-sender.js";
import type { WhatsAppPairing } from "../src/ports/whatsapp-sender.js";
import { WhatsAppWebChannel } from "../src/adapters/whatsapp/whatsapp-web-channel.js";

class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

afterEach(() => {
  whatsappMock.clients.length = 0;
  vi.restoreAllMocks();
});

describe("WhatsAppWebChannel", () => {
  it("does not write pairing codes to generic logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });

    await channel.start();
    whatsappMock.clients[0]?.handlers.get("code")?.("123456");

    expect(log.mock.calls.flat().join("\n")).not.toContain("123456");
  });

  it("logs the awaiting-link notice once, not on every qr refresh", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });

    await channel.start();
    const client = whatsappMock.clients[0];
    client?.handlers.get("qr")?.("qr-1");
    client?.handlers.get("qr")?.("qr-2");
    client?.handlers.get("qr")?.("qr-3");

    const notices = log.mock.calls.flat().join("\n").match(/Waiting to be linked/g) ?? [];
    expect(notices).toHaveLength(1);

    // A fresh unlink after a successful link should say so again.
    client?.handlers.get("authenticated")?.();
    client?.handlers.get("qr")?.("qr-4");
    expect(log.mock.calls.flat().join("\n").match(/Waiting to be linked/g)).toHaveLength(2);
  });

  it("sends the ready notification email once despite repeated ready events", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const notifier = new FakeEmailSender();
    const channel = new WhatsAppWebChannel({
      phoneNumber: "12025550108",
      readyNotification: {
        sender: notifier,
        from: "bot@example.com",
        to: "owner@example.com",
      },
    });

    await channel.start();
    const client = whatsappMock.clients[0];
    client?.handlers.get("ready")?.();
    client?.handlers.get("ready")?.();
    client?.handlers.get("ready")?.();

    expect(notifier.sent).toHaveLength(1);
  });

  it("exits the process when the client disconnects", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });

    await channel.start();
    whatsappMock.clients[0]?.handlers.get("disconnected")?.("LOGOUT");

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.flat().join("\n")).toContain("Client disconnected: LOGOUT");
  });

  it("requests pairing codes through the WhatsAppPairing port", async () => {
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });

    await channel.start();

    // The control server in index.ts reaches this method over HTTP; it must be
    // a declared port, not an incidental method on the concrete adapter.
    const pairing: WhatsAppPairing = channel;

    await expect(pairing.requestPairingCode()).resolves.toBe("123456");
  });

  it("fails sends fast with a clear error while the client is not linked", async () => {
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });

    await channel.start();
    const client = whatsappMock.clients[0];

    await expect(
      channel.sendChatMessage({ chatId: "1@c.us", text: "hi" }),
    ).rejects.toThrow("WhatsApp is not linked yet");
    expect(client?.sendMessage).not.toHaveBeenCalled();

    await expect(channel.sendImage({
      phoneNumber: "12025550109",
      text: "img",
      image: { contentType: "image/png", content: Buffer.from("x") },
    })).rejects.toThrow("WhatsApp is not linked yet");
    expect(client?.sendMessage).not.toHaveBeenCalled();
  });

  it("sends again once the client has been ready", async () => {
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });

    await channel.start();
    const client = whatsappMock.clients[0];
    client?.handlers.get("ready")?.();

    await expect(
      channel.sendChatMessage({ chatId: "1@c.us", text: "hi" }),
    ).resolves.toBeDefined();
    expect(client?.sendMessage).toHaveBeenCalledWith("1@c.us", "hi");
  });

  it("notifies once per unlinked window when sends are attempted", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const notifier = new FakeEmailSender();
    const channel = new WhatsAppWebChannel({
      phoneNumber: "12025550108",
      errorNotification: {
        sender: notifier,
        from: "bot@example.com",
        to: "owner@example.com",
      },
    });

    await channel.start();
    const client = whatsappMock.clients[0];

    await expect(
      channel.sendChatMessage({ chatId: "1@c.us", text: "hi" }),
    ).rejects.toThrow("not linked");
    await expect(
      channel.sendChatMessage({ chatId: "1@c.us", text: "again" }),
    ).rejects.toThrow("not linked");
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({
      subject: "Message Hub: WhatsApp needs re-linking",
    });

    // A fresh link resets the guard, so the next unlinked send alerts again.
    client?.handlers.get("ready")?.();
    client?.handlers.get("disconnected")?.("LOGOUT");
    await expect(
      channel.sendChatMessage({ chatId: "1@c.us", text: "third" }),
    ).rejects.toThrow("not linked");
    expect(notifier.sent).toHaveLength(2);
  });

  it("catches async inbound message handler failures", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async () => {
      throw new Error("boom");
    });

    await channel.start();

    await expect(whatsappMock.clients[0]?.handlers.get("message")?.({
      id: { _serialized: "message-1" },
      from: "12025550108@c.us",
      body: "hello",
      timestamp: 1,
    })).resolves.toBeUndefined();
    expect(log.mock.calls.flat().join("\n")).toContain("Message handler failed");
  });

  it("downloads non-image WhatsApp media attachments", async () => {
    const received: unknown[] = [];
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async message => {
      received.push(message);
    });

    await channel.start();
    await emitMessage({
      from: "12025550108@c.us",
      body: "invoice",
      hasMedia: true,
      downloadMedia: async () => ({
        mimetype: "application/pdf",
        data: Buffer.from("pdf").toString("base64"),
        filename: "invoice.pdf",
      }),
    });

    expect(received).toEqual([expect.objectContaining({
      attachments: [{
        content: Buffer.from("pdf"),
        contentType: "application/pdf",
        filename: "invoice.pdf",
      }],
    })]);
  });

  it("derives filename from mimetype when media has no filename", async () => {
    const received: unknown[] = [];
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async message => {
      received.push(message);
    });

    await channel.start();
    await emitMessage({
      from: "12025550108@c.us",
      body: "voice note",
      hasMedia: true,
      downloadMedia: async () => ({
        mimetype: "audio/ogg; codecs=opus",
        data: Buffer.from("audio").toString("base64"),
      }),
    });

    expect(received).toEqual([expect.objectContaining({
      attachments: [{
        content: Buffer.from("audio"),
        contentType: "audio/ogg; codecs=opus",
        filename: "audio.ogg",
      }],
    })]);
  });

  it("handles media download failure gracefully", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const received: unknown[] = [];
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async message => {
      received.push(message);
    });

    await channel.start();
    await emitMessage({
      from: "12025550108@c.us",
      body: "voice note",
      hasMedia: true,
      downloadMedia: async () => {
        throw new Error("Puppeteer evaluation failed");
      },
    });

    expect(received).toEqual([expect.objectContaining({
      text: "voice note",
    })]);
    expect(Object.prototype.hasOwnProperty.call(received[0], "attachments")).toBe(false);
    expect(log.mock.calls.flat().join("\n")).toContain("media download failed for message message-1");
  });

  it("logs context when media download fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async () => {});

    await channel.start();
    await emitMessage({
      from: "12025550108@c.us",
      body: "voice note",
      hasMedia: true,
      downloadMedia: async () => {
        throw new Error("Puppeteer evaluation failed");
      },
    });

    const logs = log.mock.calls.flat().join("\n");
    expect(logs).toContain("message-1");
    expect(logs).toContain("12025550108@c.us");
    expect(logs).toContain("Puppeteer evaluation failed");
  });

  it("logs received message before processing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async () => {});

    await channel.start();
    await emitMessage({
      from: "441234567890@c.us",
      body: "hello",
    });

    expect(log.mock.calls.flat().join("\n")).toMatch(
      /Received message message-1 from 441234567890@c\.us/,
    );
  });

  it("normalizes $1 to _serialized on message id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async () => {});

    await channel.start();
    await emitMessage({
      id: { '$1': "true_12025550108@c.us_XYZ789" },
      from: "12025550108@c.us",
      body: "hello",
    });

    const logs = log.mock.calls.flat().join("\n");
    expect(logs).toContain("true_12025550108@c.us_XYZ789");
  });

  it("handles missing _serialized on message id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async () => {});

    await channel.start();
    await emitMessage({
      id: {},
      from: "441234567890@c.us",
      body: "test",
      hasMedia: true,
      downloadMedia: async () => {
        throw new Error("Puppeteer evaluation failed");
      },
    });

    const logs = log.mock.calls.flat().join("\n");
    expect(logs).not.toContain("undefined");
  });

  it("reconstructs message id from id.id and from when _serialized is missing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async () => {});

    await channel.start();
    await emitMessage({
      id: { fromMe: false, id: "3EB0A1B2C3D4E5F6" },
      from: "126327990546436@lid",
      body: "photo",
      hasMedia: true,
      downloadMedia: async () => {
        throw new Error("Puppeteer evaluation failed");
      },
    });

    const logs = log.mock.calls.flat().join("\n");
    expect(logs).toContain("false_126327990546436@lid_3EB0A1B2C3D4E5F6");
    expect(logs).toContain("missing _serialized, using direct download");
  });

  it("sends error notification email when message handler crashes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const notifier = new FakeEmailSender();
    const channel = new WhatsAppWebChannel({
      phoneNumber: "12025550108",
      errorNotification: {
        sender: notifier,
        from: "bot@example.com",
        to: "owner@example.com",
      },
    });
    channel.onMessage(async () => {
      throw new Error("handler crashed");
    });

    await channel.start();
    await emitMessage({
      from: "12025550108@c.us",
      body: "hello",
    });

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({
      from: "bot@example.com",
      to: "owner@example.com",
      subject: "WhatsApp message handler failed: message-1",
    });
    expect(log.mock.calls.flat().join("\n")).toContain("Message handler failed");
  });

  it("sends error notification email when media download fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const notifier = new FakeEmailSender();
    const received: unknown[] = [];
    const channel = new WhatsAppWebChannel({
      phoneNumber: "12025550108",
      errorNotification: {
        sender: notifier,
        from: "bot@example.com",
        to: "owner@example.com",
      },
    });
    channel.onMessage(async message => {
      received.push(message);
    });

    await channel.start();
    await emitMessage({
      from: "12025550108@c.us",
      body: "voice note",
      hasMedia: true,
      downloadMedia: async () => {
        throw new Error("Puppeteer evaluation failed");
      },
    });

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({
      from: "bot@example.com",
      to: "owner@example.com",
      subject: "WhatsApp media download failed: message-1",
    });
    expect(log.mock.calls.flat().join("\n")).toContain("media download failed for message message-1");
  });

  it("does not send error notification when not configured", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async () => {
      throw new Error("handler crashed");
    });

    await channel.start();
    await emitMessage({
      from: "12025550108@c.us",
      body: "hello",
    });

    expect(log.mock.calls.flat().join("\n")).toContain("Message handler failed");
  });

  it("filters WhatsApp status messages by status settings", async () => {
    const received: unknown[] = [];
    const channel = new WhatsAppWebChannel({
      phoneNumber: "12025550108",
      forwardStatuses: {
        enabled: true,
        whitelist: ["12025550108@c.us"],
      },
    });
    channel.onMessage(async message => {
      received.push(message);
    });

    await channel.start();
    await emitMessage({
      from: "status@broadcast",
      author: "441234567890@c.us",
      body: "skip this status",
    });
    await emitMessage({
      from: "status@broadcast",
      author: "12025550108@c.us",
      body: "forward this status",
    });

    expect(received).toHaveLength(1);
  });

  it("ignores WhatsApp status messages by default", async () => {
    const received: unknown[] = [];
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async message => {
      received.push(message);
    });

    await channel.start();
    await emitMessage({
      from: "status@broadcast",
      author: "12025550108@c.us",
      body: "status",
    });

    expect(received).toEqual([]);
  });

  it("filters WhatsApp group messages by group settings", async () => {
    const received: unknown[] = [];
    const channel = new WhatsAppWebChannel({
      phoneNumber: "12025550108",
      forwardGroups: {
        enabled: true,
        blacklist: ["111@g.us"],
      },
    });
    channel.onMessage(async message => {
      received.push(message);
    });

    await channel.start();
    await emitMessage({ from: "111@g.us", body: "skip this group" });
    await emitMessage({ from: "222@g.us", body: "forward this group" });

    expect(received).toHaveLength(1);
  });

  it("ignores WhatsApp group messages by default", async () => {
    const received: unknown[] = [];
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async message => {
      received.push(message);
    });

    await channel.start();
    await emitMessage({ from: "222@g.us", body: "group" });

    expect(received).toEqual([]);
  });

  it("surfaces group invite cards via onGroupInvite without forwarding them", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const received: unknown[] = [];
    const invites: unknown[] = [];
    const channel = new WhatsAppWebChannel({ phoneNumber: "12025550108" });
    channel.onMessage(async message => {
      received.push(message);
    });
    channel.onGroupInvite(async (inviteV4, fromId, senderLabel) => {
      invites.push({ inviteV4, fromId, senderLabel });
    });

    await channel.start();
    await whatsappMock.clients[0]?.handlers.get("message")?.({
      id: { _serialized: "message-1" },
      from: "12025550108@c.us",
      body: "",
      timestamp: 1,
      type: "groups_v4_invite",
      inviteV4: {
        inviteCode: "V4CODE",
        inviteCodeExp: 1780000000,
        groupId: "120363000000000001@g.us",
        groupName: "Test Group",
        fromId: "12025550108@c.us",
        toId: "12025550108@lid",
      },
    });

    expect(received).toEqual([]);
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({
      fromId: "12025550108@c.us",
      senderLabel: "12025550108@c.us",
      inviteV4: { groupName: "Test Group" },
    });
    expect(log.mock.calls.flat().join("\n")).toContain("type: groups_v4_invite");
  });
});

async function emitMessage(overrides: {
  from: string;
  author?: string;
  body: string;
  hasMedia?: boolean;
  id?: Record<string, unknown>;
  downloadMedia?: () => Promise<{
    mimetype: string;
    data: string;
    filename?: string | null;
  } | undefined>;
}): Promise<void> {
  await whatsappMock.clients[0]?.handlers.get("message")?.({
    id: overrides.id ?? { _serialized: "message-1" },
    timestamp: 1,
    ...overrides,
  });
}
