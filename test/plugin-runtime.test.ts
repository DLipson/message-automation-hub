import { describe, expect, it } from "vitest";
import {
  createPluginContext,
  registerPlugins,
} from "../src/core/plugin-runtime.js";
import type { HubPlugin } from "../src/api/index.js";

describe("plugin runtime", () => {
  it("registers plugins in order and exposes provided capabilities", async () => {
    const calls: string[] = [];
    const provider: HubPlugin = {
      name: "provider",
      onLoad(ctx) {
        calls.push("provider");
        ctx.provide("test.answer", 42);
      },
    };
    const consumer: HubPlugin = {
      name: "consumer",
      onLoad(ctx) {
        calls.push(`consumer:${ctx.require("test.answer")}`);
      },
    };

    const ctx = await registerPlugins([provider, consumer]);

    expect(calls).toEqual(["provider", "consumer:42"]);
    expect(ctx.require("test.answer")).toBe(42);
  });

  it("waits for async plugin registration before loading dependents", async () => {
    const provider: HubPlugin = {
      name: "async-provider",
      async onLoad(ctx) {
        await Promise.resolve();
        ctx.provide("test.ready", true);
      },
    };
    const consumer: HubPlugin = {
      name: "consumer",
      onLoad(ctx) {
        ctx.provide("test.observed", ctx.require("test.ready"));
      },
    };

    const ctx = await registerPlugins([provider, consumer]);

    expect(ctx.require("test.observed")).toBe(true);
  });

  it("rejects duplicate plugin names", async () => {
    await expect(registerPlugins([
      { name: "same", onLoad() {} },
      { name: "same", onLoad() {} },
    ])).rejects.toThrow('Duplicate plugin "same".');
  });

  it("rejects duplicate capability providers", () => {
    const ctx = createPluginContext();

    ctx.provide("test.answer", 1);

    expect(() => ctx.provide("test.answer", 2)).toThrow(
      'Capability "test.answer" has already been provided.',
    );
  });

  it("still guards empty names at runtime for callers without types", async () => {
    expect(() => createPluginContext().provide(" " as string, 1 as never)).toThrow(
      "Capability name is required.",
    );
    expect(() => createPluginContext().require("" as string)).toThrow(
      "Capability name is required.",
    );
    await expect(registerPlugins([
      { name: " ", onLoad() {} },
    ])).rejects.toThrow("Plugin name is required.");
  });

  it("provides config to plugins", async () => {
    const plugin: HubPlugin = {
      name: "config-reader",
      onLoad(ctx) {
        ctx.provide("test.customKey", ctx.config.customKey);
      },
    };
    const ctx = await registerPlugins([plugin], { customKey: "hello" });

    expect(ctx.require("test.customKey")).toBe("hello");
  });

  it("provides formatError utility", async () => {
    const plugin: HubPlugin = {
      name: "error-formatter",
      onLoad(ctx) {
        ctx.provide("test.result", ctx.formatError(new Error("oops")));
      },
    };
    const ctx = await registerPlugins([plugin]);

    expect(ctx.require("test.result")).toBe("oops");
  });
});

describe("event system", () => {
  it("fires a registered handler when the event is emitted", async () => {
    const ctx = createPluginContext();
    const ids: string[] = [];

    ctx.on("email.received", async ({ email }) => {
      ids.push(email.id);
      return true;
    });

    const result = await ctx.emit("email.received", {
      email: { id: "e1", subject: "", text: "", receivedAt: new Date() },
      batch: { sentWhatsAppImage: false },
    });

    expect(result).toBe(true);
    expect(ids).toEqual(["e1"]);
  });

  it("calls handlers in order until one returns true", async () => {
    const ctx = createPluginContext();
    const order: number[] = [];

    ctx.on("email.received", async () => { order.push(1); return false; });
    ctx.on("email.received", async () => { order.push(2); return true; });
    ctx.on("email.received", async () => { order.push(3); return true; });

    const result = await ctx.emit("email.received", {
      email: { id: "e1", subject: "", text: "", receivedAt: new Date() },
      batch: { sentWhatsAppImage: false },
    });

    expect(result).toBe(true);
    expect(order).toEqual([1, 2]);
  });

  it("returns false when no handler is registered for the event", async () => {
    const ctx = createPluginContext();

    const result = await ctx.emit("email.received", {
      email: { id: "e1", subject: "", text: "", receivedAt: new Date() },
      batch: { sentWhatsAppImage: false },
    });

    expect(result).toBe(false);
  });

  it("propagates errors thrown by handlers", async () => {
    const ctx = createPluginContext();

    ctx.on("email.received", async () => { throw new Error("oops"); });

    await expect(ctx.emit("email.received", {
      email: { id: "e1", subject: "", text: "", receivedAt: new Date() },
      batch: { sentWhatsAppImage: false },
    })).rejects.toThrow("oops");
  });

  it("rejects empty event names at runtime", async () => {
    const ctx = createPluginContext();

    expect(() => ctx.on("", () => Promise.resolve(true))).toThrow(
      "Event name is required.",
    );
    await expect(ctx.emit("", {} as never)).rejects.toThrow(
      "Event name is required.",
    );
  });
});
