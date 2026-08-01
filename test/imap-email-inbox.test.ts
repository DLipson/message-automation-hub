import { beforeEach, describe, expect, it, vi } from "vitest";

const imapMock = vi.hoisted(() => {
  const clients: FakeImapFlow[] = [];
  const connectErrors: unknown[] = [];

  let idleResolve: (() => void) | undefined;

  class FakeImapFlow {
    // A real ImapFlow cannot be reconnected (connect() throws on reuse), so each
    // attempt builds a new one. Tracking close() per instance is what proves a
    // failed attempt did not abandon its socket.
    readonly connect = vi.fn(async () => {
      const error = connectErrors.shift();

      if (error) {
        throw error;
      }
    });
    readonly logout = vi.fn(async () => {
      idleResolve?.();
    });
    readonly close = vi.fn();
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

  function reset(): void {
    idleResolve = undefined;
    clients.length = 0;
    connectErrors.length = 0;
  }

  function failNextConnects(...errors: unknown[]): void {
    connectErrors.push(...errors);
  }

  function endIdle(): void {
    idleResolve?.();
    idleResolve = undefined;
  }

  return { clients, FakeImapFlow, reset, failNextConnects, endIdle };
});

vi.mock("imapflow", () => ({
  ImapFlow: imapMock.FakeImapFlow,
}));

// Retry backoff would otherwise make these tests wait 75 real seconds; vitest's
// fake timers do not patch node:timers/promises.
vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn(async () => {}),
}));

import {
  ImapEmailInbox,
  isAuthenticationFailure,
} from "../src/adapters/email/imap-email-inbox.js";

beforeEach(() => {
  imapMock.reset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const tooManyConnections = () => Object.assign(new Error("Command failed"), {
  response: "3 NO [ALERT] Too many simultaneous connections. (Failure)",
  responseText: "Too many simultaneous connections. (Failure)",
  serverResponseCode: "ALERT",
  authenticationFailed: true,
});

const badCredentials = () => Object.assign(new Error("Command failed"), {
  serverResponseCode: "AUTHENTICATIONFAILED",
  authenticationFailed: true,
});

describe("isAuthenticationFailure", () => {
  it("detects permanently rejected credentials", () => {
    expect(isAuthenticationFailure(Object.assign(new Error("nope"), {
      serverResponseCode: "AUTHENTICATIONFAILED", authenticationFailed: true,
    }))).toBe(true);
  });

  it("treats transient errors and non-errors as retryable", () => {
    // Gmail sends this mid-AUTHENTICATE with authenticationFailed: true, but it clears on its own.
    expect(isAuthenticationFailure(Object.assign(new Error("Command failed"), {
      responseText: "Too many simultaneous connections. (Failure)",
      serverResponseCode: "ALERT",
      authenticationFailed: true,
    }))).toBe(false);
    expect(isAuthenticationFailure(new Error("ETIMEDOUT"))).toBe(false);
    expect(isAuthenticationFailure(undefined)).toBe(false);
  });
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

  describe("connect retry", () => {
    it("retries a transient connect failure and closes the abandoned client", async () => {
      imapMock.failNextConnects(tooManyConnections());
      const inbox = new ImapEmailInbox(config());

      await inbox.ensureLabels(["WA/Failed"]);

      // imapflow leaves the socket open when AUTHENTICATE is refused, so an
      // unclosed retry leaks a connection into the very limit it is retrying.
      expect(imapMock.clients).toHaveLength(2);
      expect(imapMock.clients[0]?.close).toHaveBeenCalledTimes(1);
      expect(imapMock.clients[1]?.mailboxCreate).toHaveBeenCalledWith("WA/Failed");
      expect(imapMock.clients[1]?.close).not.toHaveBeenCalled();
    });

    it("closes every client when all connect attempts fail", async () => {
      imapMock.failNextConnects(
        tooManyConnections(),
        tooManyConnections(),
        tooManyConnections(),
        tooManyConnections(),
        tooManyConnections(),
      );
      const inbox = new ImapEmailInbox(config());

      await expect(inbox.fetchUnread()).rejects.toThrow("Command failed");

      expect(imapMock.clients).toHaveLength(5);
      for (const client of imapMock.clients) {
        expect(client.close).toHaveBeenCalledTimes(1);
      }
    });

    it("closes the client when credentials are permanently rejected", async () => {
      imapMock.failNextConnects(badCredentials());
      const inbox = new ImapEmailInbox(config());

      await expect(inbox.markProcessed(email())).rejects.toThrow("Command failed");

      expect(imapMock.clients).toHaveLength(1);
      expect(imapMock.clients[0]?.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("watcher connection hygiene", () => {
    it("closes the failed client before reconnecting", async () => {
      imapMock.failNextConnects(tooManyConnections());
      const inbox = new ImapEmailInbox(config());

      const stop = await inbox.watchNewMail(vi.fn());

      expect(imapMock.clients[0]?.close).toHaveBeenCalledTimes(1);

      await stop();
    });

    it("closes the previous client when an IDLE cycle ends", async () => {
      const inbox = new ImapEmailInbox(config());
      const stop = await inbox.watchNewMail(vi.fn());

      // Normal operation: imapflow breaks IDLE every maxIdleTime (25 minutes) and
      // the loop reconnects. The finished client must not be left open.
      imapMock.endIdle();
      await vi.waitFor(() => expect(imapMock.clients).toHaveLength(2));

      expect(imapMock.clients[0]?.close).toHaveBeenCalledTimes(1);

      await stop();
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


