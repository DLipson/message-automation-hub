import { beforeEach, describe, expect, it, vi } from "vitest";

const imapMock = vi.hoisted(() => {
  const clients: FakeImapFlow[] = [];

  let idleResolve: (() => void) | undefined;

  class FakeImapFlow {
    readonly connect = vi.fn(async () => {});
    readonly logout = vi.fn(async () => {
      idleResolve?.();
    });
    readonly mailboxOpen = vi.fn(async () => {});
    readonly mailboxCreate = vi.fn(async () => {});
    readonly messageFlagsAdd = vi.fn(async () => {});
    readonly messageFlagsRemove = vi.fn(async () => {});
    readonly on = vi.fn();
    readonly off = vi.fn();
    readonly removeAllListeners = vi.fn();
    readonly idle = vi.fn(() => {
      return new Promise<void>(resolve => {
        idleResolve = resolve;
      });
    });

    constructor() {
      clients.push(this);
    }
  }

  function resetIdle(): void {
    idleResolve = undefined;
  }

  return { clients, FakeImapFlow, resetIdle };
});

vi.mock("imapflow", () => ({
  ImapFlow: imapMock.FakeImapFlow,
}));

import { ImapEmailInbox } from "../src/adapters/email/imap-email-inbox.js";

beforeEach(() => {
  imapMock.clients.length = 0;
  imapMock.resetIdle();
});

describe("ImapEmailInbox", () => {
  describe("watchNewMail", () => {
    it("connects, opens INBOX, and starts IDLE", async () => {
      const inbox = new ImapEmailInbox(config());
      const callback = vi.fn();

      const stop = await inbox.watchNewMail(callback);
      const client = imapMock.clients.find(c => c.connect.mock.calls.length > 0);
      expect(client?.connect).toHaveBeenCalledTimes(1);
      expect(client?.mailboxOpen).toHaveBeenCalledWith("INBOX");
      expect(client?.idle).toHaveBeenCalledTimes(1);

      await stop();
    });

    it("calls callback after exists event debounced", async () => {
      vi.useFakeTimers();
      const inbox = new ImapEmailInbox(config());
      const callback = vi.fn();

      const stop = await inbox.watchNewMail(callback);
      const client = imapMock.clients.find(c => c.on.mock.calls.length > 0);
      const existsHandler = client?.on.mock.calls.find(
        (args: any[]) => args[0] === "exists",
      )?.[1] as (() => void) | undefined;

      existsHandler?.();
      existsHandler?.();

      await vi.advanceTimersByTimeAsync(1100);

      expect(callback).toHaveBeenCalledTimes(1);

      await stop();
      vi.useRealTimers();
    });

    it("stop function logs out and cleans up", async () => {
      const inbox = new ImapEmailInbox(config());
      const callback = vi.fn();

      const stop = await inbox.watchNewMail(callback);
      await stop();

      const client = imapMock.clients.find(c => c.logout.mock.calls.length > 0);
      expect(client?.logout).toHaveBeenCalledTimes(1);
    });
  });

  it("creates Gmail status labels", async () => {
    const inbox = new ImapEmailInbox(config());

    await inbox.ensureLabels(["WA/Sent", "WA/Delivered", "WA/Failed"]);

    const client = imapMock.clients[0];
    expect(client?.mailboxCreate).toHaveBeenCalledWith("WA");
    expect(client?.mailboxCreate).toHaveBeenCalledWith("WA/Sent");
    expect(client?.mailboxCreate).toHaveBeenCalledWith("WA/Delivered");
    expect(client?.mailboxCreate).toHaveBeenCalledWith("WA/Failed");
  });

  it("adds Gmail sent label without replacing existing labels", async () => {
    const inbox = new ImapEmailInbox(config());

    await inbox.markSent(email());

    const client = imapMock.clients[0];
    expect(client?.mailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(client?.messageFlagsRemove).toHaveBeenCalledWith(42, ["WA/Failed"], {
      uid: true,
      useLabels: true,
    });
    expect(client?.messageFlagsAdd).toHaveBeenCalledWith(42, ["WA/Sent"], {
      uid: true,
      useLabels: true,
    });
  });

  it("adds Gmail delivered label and removes sent/failed labels", async () => {
    const inbox = new ImapEmailInbox(config());

    await inbox.markDelivered(email());

    const client = imapMock.clients[0];
    expect(client?.mailboxOpen).toHaveBeenCalledWith("INBOX");
    expect(client?.messageFlagsRemove).toHaveBeenCalledWith(42, ["WA/Sent", "WA/Failed"], {
      uid: true,
      useLabels: true,
    });
    expect(client?.messageFlagsAdd).toHaveBeenCalledWith(42, ["WA/Delivered"], {
      uid: true,
      useLabels: true,
    });
  });

  it("adds Gmail failed label and clears both sent and delivered labels", async () => {
    const inbox = new ImapEmailInbox(config());

    await inbox.markFailed(email());

    const client = imapMock.clients[0];
    expect(client?.messageFlagsAdd).toHaveBeenCalledWith(42, ["\\Seen"], {
      uid: true,
    });
    expect(client?.messageFlagsRemove).toHaveBeenCalledWith(42, ["WA/Sent", "WA/Delivered"], {
      uid: true,
      useLabels: true,
    });
    expect(client?.messageFlagsAdd).toHaveBeenCalledWith(42, ["WA/Failed"], {
      uid: true,
      useLabels: true,
    });
  });
});

function config() {
  return {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    user: "me@example.com",
    pass: "secret",
  };
}

function email() {
  return {
    id: "42",
    subject: "WA: 12025550108",
    text: "hello",
    receivedAt: new Date("2026-06-21T08:00:00.000Z"),
  };
}


