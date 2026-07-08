import { describe, expect, it, vi } from "vitest";
import { EmailToWhatsAppPoller } from "../src/email-to-whatsapp-poller.js";

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
    const poller = new EmailToWhatsAppPoller(processor, 1000);

    poller.start();
    await vi.advanceTimersByTimeAsync(3000);

    expect(processor.calls).toBe(1);
    expect(warn).toHaveBeenCalled();

    finishPoll?.();
    await vi.runOnlyPendingTimersAsync();
    poller.stop();
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
    const poller = new EmailToWhatsAppPoller(processor, 1000);

    poller.start();
    await vi.runOnlyPendingTimersAsync();
    poller.stop();

    expect(error.mock.calls[0]?.[0]).toContain("TypeError: send exploded");

    error.mockRestore();
    vi.useRealTimers();
  });
});
