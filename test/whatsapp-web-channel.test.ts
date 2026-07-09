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

import { WhatsAppWebChannel } from "../src/adapters/whatsapp/whatsapp-web-channel.js";

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
});

async function emitMessage(overrides: {
  from: string;
  author?: string;
  body: string;
}): Promise<void> {
  await whatsappMock.clients[0]?.handlers.get("message")?.({
    id: { _serialized: "message-1" },
    timestamp: 1,
    ...overrides,
  });
}


