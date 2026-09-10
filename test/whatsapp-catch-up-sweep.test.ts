import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "whatsapp-web.js";
import {
  CatchUpSweep,
  messageIdFor,
  serializedIdOf,
  type CatchUpStateRef,
} from "../src/adapters/whatsapp/whatsapp-catch-up-sweep.js";
import type { CatchUpState } from "../src/adapters/whatsapp/json-whatsapp-catch-up-store.js";

type FetchedMessage = {
  id: { _serialized: string };
  fromMe: boolean;
  from: string;
  body: string;
  timestamp: number;
};

type StoreLike = {
  load(): Promise<CatchUpState>;
  save(state: CatchUpState): Promise<void>;
};

// A real file-backed store reads fresh bytes off disk on every load, so the fake
// must hand back a FRESH CLONE per load too. `persisted()` returns the live
// snapshot for seeding a "restart"; `load`/`save` never share an object reference.
function fakeStore(initial: CatchUpState) {
  let persisted = structuredClone(initial);
  return {
    persisted: () => structuredClone(persisted),
    load: vi.fn(async () => structuredClone(persisted)),
    save: vi.fn(async (state: CatchUpState) => { persisted = structuredClone(state); }),
  };
}

function makeChat(messages: FetchedMessage[]): Chat {
  return {
    id: { id: "123@c.us" },
    lastMessage: { timestamp: messages[messages.length - 1]!.timestamp },
    fetchMessages: vi.fn(async () => messages),
  } as unknown as Chat;
}

// Returns the sweep plus a live handle on the stateRef it shares with the
// caller, so a test can drive the ref exactly like the channel does.
function makeSweep(deps: {
  store: StoreLike;
  getChats?: () => Promise<Chat[]>;
  log?: (message: string) => void;
  notifyError?: (subject: string, text: string) => Promise<void>;
  stateRef?: CatchUpStateRef;
}) {
  let holder: CatchUpState | null = null;
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
    notifyError: deps.notifyError ?? (async () => {}),
    serializedIdOf,
    messageIdFor,
    log: deps.log ?? (() => {}),
    stateRef: deps.stateRef ?? {
      get: () => holder,
      set: state => { holder = state; },
    },
  });
  return { sweep, holder: () => holder };
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
    const { sweep } = makeSweep({
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

  it("retries the catch-up chat list for a longer budget instead of three-and-die", async () => {
    vi.useFakeTimers();
    const store = fakeStore({ initialized: true, chats: { "123@c.us": 0 } });
    const log = vi.fn();
    // Page still syncing for the first three attempts (which the old 3-try code
    // would have abandoned), then the chat list appears.
    const getChats = vi.fn()
      .mockRejectedValueOnce(new Error("r: r"))
      .mockRejectedValueOnce(new Error("r: r"))
      .mockRejectedValueOnce(new Error("r: r"))
      .mockResolvedValueOnce([]);
    const { sweep } = makeSweep({ store, getChats, log });
    sweep.setForward(async () => {});

    const run = sweep.runCatchUpIfPending();
    // Attempt delays grow 5s, 10s, 15s; the appointment for attempt 4 sits at
    // 5+10+15 = 30s. Advance past it.
    await vi.advanceTimersByTimeAsync(32_000);
    await run;

    expect(getChats).toHaveBeenCalledTimes(4);
    expect(log.mock.calls.flat().join("\n")).not.toContain("Catch-up scan failed");
  });

  it("alerts when the catch-up sweep ultimately gives up", async () => {
    vi.useFakeTimers();
    const store = fakeStore({ initialized: true, chats: { "123@c.us": 0 } });
    const notifyError = vi.fn(async () => {});
    const log = vi.fn();
    // Page never becomes readable within the 120s budget.
    const getChats = vi.fn().mockRejectedValue(new Error("r: r"));
    const { sweep } = makeSweep({ store, getChats, log, notifyError });
    sweep.setForward(async () => {});

    const run = sweep.runCatchUpIfPending();
    // Budget is 120s with 5→30s backoff sleeps (last sleep ends ~135s).
    await vi.advanceTimersByTimeAsync(145_000);
    await run;

    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0][0]).toContain("catch-up scan failed");
    expect(notifyError.mock.calls[0][0]).toContain("catch-up scan failed");
  });

  it("records a baseline on the first run and forwards nothing", async () => {
    const store = fakeStore({ initialized: false, chats: {} });
    const getChats = vi.fn();
    const forwarded: unknown[] = [];
    const { sweep } = makeSweep({ store, getChats: getChats as never });
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
    const { sweep } = makeSweep({ store, getChats: async () => [chat] });
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
    const { sweep: firstSweep } = makeSweep({ store: firstRunStore, getChats: async () => [chat] });
    firstSweep.setForward(async message => { firstForwarded.push(message.text); });

    await firstSweep.runCatchUpIfPending();
    expect(firstForwarded).toEqual(["old", "new"]);

    const restartedStore = fakeStore(firstRunStore.persisted());
    const restartedForwarded: string[] = [];
    const restartedChat = makeChat([
      { id: { _serialized: "m-old" }, fromMe: false, from: "123@c.us", body: "old", timestamp: 50 },
      { id: { _serialized: "m-new" }, fromMe: false, from: "123@c.us", body: "new", timestamp: 200 },
    ]);
    const { sweep: restartedSweep } = makeSweep({
      store: restartedStore,
      getChats: async () => [restartedChat],
    });
    restartedSweep.setForward(async message => { restartedForwarded.push(message.text); });

    await restartedSweep.runCatchUpIfPending();

    expect(restartedForwarded).toEqual([]);
  });

  it("shares one CatchUpState object between the live path and the sweep", async () => {
    let persisted: CatchUpState = {
      initialized: true,
      chats: { "123@c.us": 100 },
      baseline: 100,
    };
    let holder: CatchUpState | null = null;
    let loads = 0;
    // Chat list appears only after the "page sync" (mirrors the ready re-sync
    // storm: run 1 loads the holder while no chats are visible yet).
    let chatVisible = false;
    const store: StoreLike = {
      load: async () => { loads += 1; return structuredClone(persisted); },
      save: async (state: CatchUpState) => { persisted = structuredClone(state); },
    };
    const chat = makeChat([
      { id: { _serialized: "m-new" }, fromMe: false, from: "123@c.us", body: "new", timestamp: 200 },
    ]);
    const forwarded: string[] = [];
    const { sweep } = makeSweep({
      store,
      getChats: async () => (chatVisible ? [chat] : []),
      stateRef: { get: () => holder, set: s => { holder = s; } },
    });
    sweep.setForward(async message => { forwarded.push(message.text); });

    // Run 1 lazily loads the store into the shared holder; nothing to sweep yet.
    await sweep.runCatchUpIfPending();
    expect(loads).toBe(1);

    // The live-message path advances the SAME object the sweep holds.
    sweep.trackWatermark("123@c.us", 200);

    // Run 2 now sees the ts-200 chat; it must find nothing to forward because
    // the holder already carries the watermark the live path wrote.
    chatVisible = true;
    await sweep.runCatchUpIfPending();

    expect(forwarded).toEqual([]);
    expect(loads).toBe(1);
  });
});