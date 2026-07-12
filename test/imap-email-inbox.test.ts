import { beforeEach, describe, expect, it, vi } from "vitest";

const imapMock = vi.hoisted(() => {
  const clients: FakeImapFlow[] = [];

  class FakeImapFlow {
    readonly connect = vi.fn(async () => {});
    readonly logout = vi.fn(async () => {});
    readonly mailboxOpen = vi.fn(async () => {});
    readonly mailboxCreate = vi.fn(async () => {});
    readonly messageFlagsAdd = vi.fn(async () => {});
    readonly messageFlagsRemove = vi.fn(async () => {});
    readonly on = vi.fn();

    constructor() {
      clients.push(this);
    }
  }

  return { clients, FakeImapFlow };
});

vi.mock("imapflow", () => ({
  ImapFlow: imapMock.FakeImapFlow,
}));

import { ImapEmailInbox } from "../src/adapters/email/imap-email-inbox.js";

beforeEach(() => {
  imapMock.clients.length = 0;
});

describe("ImapEmailInbox", () => {
  it("creates Gmail status labels", async () => {
    const inbox = new ImapEmailInbox(config());

    await inbox.ensureLabels(["WA/Sent", "WA/Failed"]);

    const client = imapMock.clients[0];
    expect(client?.mailboxCreate).toHaveBeenCalledWith("WA");
    expect(client?.mailboxCreate).toHaveBeenCalledWith("WA/Sent");
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

  it("adds Gmail failed label without replacing existing labels", async () => {
    const inbox = new ImapEmailInbox(config());

    await inbox.markFailed(email());

    const client = imapMock.clients[0];
    expect(client?.messageFlagsRemove).toHaveBeenCalledWith(42, ["WA/Sent"], {
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


