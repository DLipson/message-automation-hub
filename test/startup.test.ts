import { describe, expect, it, vi } from "vitest";
import { reportStartupFailure } from "../src/startup.js";

describe("reportStartupFailure", () => {
  it("leads with one grep-able line naming the failure", () => {
    const log = vi.fn();

    reportStartupFailure(Object.assign(new Error("Command failed"), {
      responseText: "Too many simultaneous connections. (Failure)",
    }), log);

    // The outage this exists for produced a bare "Error: Command failed" stack in
    // the journal, which says nothing about what failed or that it was startup.
    expect(log.mock.calls[0]?.[0]).toBe(
      "Message Automation Hub failed to start: Command failed: Too many simultaneous connections. (Failure)",
    );
  });

  it("keeps the stack for unexpected failures", () => {
    const log = vi.fn();
    const error = new Error("boom");

    reportStartupFailure(error, log);

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toBe(error.stack);
  });

  it("handles a thrown non-error", () => {
    const log = vi.fn();

    reportStartupFailure("just a string", log);

    expect(log.mock.calls[0]?.[0]).toBe(
      "Message Automation Hub failed to start: just a string",
    );
  });
});
