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
});
