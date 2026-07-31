import { describe, expect, it, vi } from "vitest";
import { EmailToWhatsAppPoller } from "../src/email-to-whatsapp-poller.js";

function stubInbox() {
  return {
    fetchUnread: vi.fn(),
    markProcessed: vi.fn(),
    watchNewMail: vi.fn(async () => async () => {}),
  };
}

describe("EmailToWhatsAppPoller", () => {
  it("does not start a second poll while the previous poll is still running", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let finishPoll: (() => void) | undefined;
    const processor = {
      calls: 0,
      async processUnread(): Promise<void> {
        this.calls += 1;
        await new Promise<void>(resolve => {
          finishPoll = resolve;
        });
      },
    };
    const poller = new EmailToWhatsAppPoller(processor, stubInbox(), 1000);

    await poller.start();
    await vi.advanceTimersByTimeAsync(3000);

    expect(processor.calls).toBe(1);
    expect(warn).not.toHaveBeenCalled();

    finishPoll?.();
    await vi.runOnlyPendingTimersAsync();
    await poller.stop();
    warn.mockRestore();
    vi.useRealTimers();
  });
  it("logs stack details when a poll fails", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const processor = {
      async processUnread(): Promise<void> {
        throw new TypeError("send exploded");
      },
    };
    const poller = new EmailToWhatsAppPoller(processor, stubInbox(), 1000);

    await poller.start();
    await vi.runOnlyPendingTimersAsync();
    await poller.stop();

    expect(error.mock.calls[0]?.[0]).toContain("TypeError: send exploded");

    error.mockRestore();
    vi.useRealTimers();
  });
  it("calls processUnread when watcher callback fires", async () => {
    vi.useFakeTimers();
    let notify: (() => void) | undefined;
    const inbox = {
      fetchUnread: vi.fn(),
      markProcessed: vi.fn(),
      watchNewMail: vi.fn((callback: () => void) => {
        notify = callback;
        return Promise.resolve(async () => {});
      }),
    };
    const processor = { processUnread: vi.fn(async () => {}) };
    const poller = new EmailToWhatsAppPoller(processor, inbox, 100000);

    await poller.start();

    // First poll is immediate (delayMs=0)
    await vi.advanceTimersByTimeAsync(0);
    expect(processor.processUnread).toHaveBeenCalledTimes(1);

    processor.processUnread.mockClear();
    notify?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(processor.processUnread).toHaveBeenCalledTimes(1);

    await poller.stop();
    vi.useRealTimers();
  });
  it("stop function unwatches the inbox", async () => {
    const stopWatching = vi.fn(async () => {});
    const inbox = {
      fetchUnread: vi.fn(),
      markProcessed: vi.fn(),
      watchNewMail: vi.fn(() => Promise.resolve(stopWatching)),
    };
    const processor = { processUnread: vi.fn(async () => {}) };
    const poller = new EmailToWhatsAppPoller(processor, inbox, 100000);

    await poller.start();
    expect(inbox.watchNewMail).toHaveBeenCalledTimes(1);
    await poller.stop();
    expect(stopWatching).toHaveBeenCalledTimes(1);
  });
});
