import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "whatsapp-web.js";
import {
  CatchUpSweep,
  messageIdFor,
  serializedIdOf,
} from "../src/adapters/whatsapp/whatsapp-catch-up-sweep.js";
import type { CatchUpState } from "../src/adapters/whatsapp/json-whatsapp-catch-up-store.js";

type FetchedMessage = {
  id: { _serialized: string };
  fromMe: boolean;
  from: string;
  body: string;
  timestamp: number;
};

function fakeStore(initial: CatchUpState) {
  let persisted = initial;
  return {
    persisted: () => persisted,
    load: vi.fn(async () => persisted),
    save: vi.fn(async (state: CatchUpState) => { persisted = state; }),
  };
}

function makeChat(messages: FetchedMessage[]): Chat {
  return {
    id: { id: "123@c.us" },
    lastMessage: { timestamp: messages[messages.length - 1]!.timestamp },
    fetchMessages: vi.fn(async () => messages),
  } as unknown as Chat;
}

function makeSweep(deps: {
  store: ReturnType<typeof fakeStore>;
  getChats?: () => Promise<Chat[]>;
  log?: (message: string) => void;
}) {
  const sweep = new CatchUpSweep({
    store: deps.store,
    getChats: deps.getChats ?? (async () => []),
    toInboundMessage: async message => ({
      id: message.id._serialized,
      channel: "whatsapp",
      from: { id: message.from },
      text: message.body,
      receivedAt: new Date(message.timestamp * 1000),
    }),
    shouldHandle: () => true,
    notifyError: async () => {},
    serializedIdOf,
    messageIdFor,
    log: deps.log ?? (() => {}),
    stateRef: { get: () => null, set: () => {} },
  });
  return sweep;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CatchUpSweep", () => {
  it("retries the catch-up chat list instead of abandoning the sweep on a transient failure", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const getChats = vi.fn()
      .mockRejectedValueOnce(new Error("page still syncing"))
      .mockResolvedValueOnce([]);
    const sweep = makeSweep({
      store: fakeStore({ initialized: true, chats: { "123@c.us": 0 } }),
      getChats,
      log,
    });
    sweep.setForward(async () => {});

    const run = sweep.runCatchUpIfPending();
    await vi.advanceTimersByTimeAsync(6000);
    await run;

    expect(getChats).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join("\n")).not.toContain("Catch-up scan failed");
  });

  it("records a baseline on the first run and forwards nothing", async () => {
    const store = fakeStore({ initialized: false, chats: {} });
    const getChats = vi.fn();
    const forwarded: unknown[] = [];
    const sweep = makeSweep({ store, getChats: getChats as never });
    sweep.setForward(async message => { forwarded.push(message); });

    await sweep.runCatchUpIfPending();

    expect(getChats).not.toHaveBeenCalled();
    expect(forwarded).toEqual([]);
    const saved = store.persisted();
    expect(saved.initialized).toBe(true);
    expect(saved.baseline).toEqual(expect.any(Number));
    expect(saved.chats).toEqual({});
  });

  it("forwards only messages newer than the watermark after a baseline exists", async () => {
    const store = fakeStore({
      initialized: true,
      chats: { "123@c.us": 100 },
      baseline: 100,
    });
    const chat = makeChat([
      { id: { _serialized: "m-old" }, fromMe: false, from: "123@c.us", body: "old", timestamp: 50 },
      { id: { _serialized: "m-new" }, fromMe: false, from: "123@c.us", body: "new", timestamp: 200 },
    ]);
    const forwarded: string[] = [];
    const sweep = makeSweep({ store, getChats: async () => [chat] });
    sweep.setForward(async message => { forwarded.push(message.text); });

    await sweep.runCatchUpIfPending();

    expect(forwarded).toEqual(["new"]);
    expect(store.persisted().chats["123@c.us"]).toBe(200);
  });

  it("respects the persisted watermark across a restart", async () => {
    const firstRunStore = fakeStore({
      initialized: true,
      chats: { "123@c.us": 0 },
      baseline: 0,
    });
    const chat = makeChat([
      { id: { _serialized: "m-old" }, fromMe: false, from: "123@c.us", body: "old", timestamp: 50 },
      { id: { _serialized: "m-new" }, fromMe: false, from: "123@c.us", body: "new", timestamp: 200 },
    ]);
    const firstForwarded: string[] = [];
    const firstSweep = makeSweep({ store: firstRunStore, getChats: async () => [chat] });
    firstSweep.setForward(async message => { firstForwarded.push(message.text); });

    await firstSweep.runCatchUpIfPending();
    expect(firstForwarded).toEqual(["old", "new"]);

    const restartedStore = fakeStore(firstRunStore.persisted());
    const restartedForwarded: string[] = [];
    const restartedChat = makeChat([
      { id: { _serialized: "m-old" }, fromMe: false, from: "123@c.us", body: "old", timestamp: 50 },
      { id: { _serialized: "m-new" }, fromMe: false, from: "123@c.us", body: "new", timestamp: 200 },
    ]);
    const restartedSweep = makeSweep({
      store: restartedStore,
      getChats: async () => [restartedChat],
    });
    restartedSweep.setForward(async message => { restartedForwarded.push(message.text); });

    await restartedSweep.runCatchUpIfPending();

    expect(restartedForwarded).toEqual([]);
  });
});