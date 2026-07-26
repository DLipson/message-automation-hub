import { describe, expect, it } from "vitest";
import {
  createPluginContext,
  registerPlugins,
  type CapabilityName,
  type HubPlugin,
} from "../src/core/plugin-runtime.js";

// This is the declaration an out-of-repo plugin package writes to register its
// own capabilities with the typed registry. If this stops working, plugins
// outside core lose compile-time checking, so it is exercised here on purpose.
declare module "../src/core/plugin-runtime.js" {
  interface Capabilities {
    "test.answer": number;
    "test.ready": boolean;
    "test.observed": boolean;
  }
}

describe("plugin runtime", () => {
  it("registers plugins in order and exposes provided capabilities", async () => {
    const calls: string[] = [];
    const provider: HubPlugin = {
      id: "provider",
      register(ctx) {
        calls.push("provider");
        ctx.provide("test.answer", 42);
      },
    };
    const consumer: HubPlugin = {
      id: "consumer",
      requires: ["test.answer"],
      register(ctx) {
        calls.push(`consumer:${ctx.require("test.answer")}`);
      },
    };

    const ctx = await registerPlugins([provider, consumer]);

    expect(calls).toEqual(["provider", "consumer:42"]);
    expect(ctx.require("test.answer")).toBe(42);
  });

  it("infers the capability type from its name without a cast", async () => {
    const ctx = createPluginContext();

    ctx.provide("test.answer", 42);

    // Compiles only because require() looks the type up rather than trusting
    // a caller-supplied type argument.
    const answer: number = ctx.require("test.answer");

    expect(answer).toBe(42);
  });

  it("rejects wrong types, wrong shapes, and unknown names at compile time", () => {
    const ctx = createPluginContext();

    // @ts-expect-error test.answer is a number, not a string
    ctx.provide("test.answer", "forty-two");

    // @ts-expect-error email.send must satisfy the EmailSender port
    ctx.provide("email.send", { deliver() {} });

    // @ts-expect-error unregistered capability names are not assignable
    ctx.provide("nope.not.registered", 1);

    // @ts-expect-error require() rejects unregistered names too
    ctx.require("nope.not.registered");

    // @ts-expect-error a typo in a requires entry is caught before runtime
    const typo: HubPlugin = { id: "typo", requires: ["email.snd"], register() {} };

    expect(typo.id).toBe("typo");
  });

  it("waits for async plugin registration before registering dependents", async () => {
    const provider: HubPlugin = {
      id: "async-provider",
      async register(ctx) {
        await Promise.resolve();
        ctx.provide("test.ready", true);
      },
    };
    const consumer: HubPlugin = {
      id: "consumer",
      requires: ["test.ready"],
      register(ctx) {
        ctx.provide("test.observed", ctx.require("test.ready"));
      },
    };

    const ctx = await registerPlugins([provider, consumer]);

    expect(ctx.require("test.observed")).toBe(true);
  });

  it("fails before registration when a required capability is missing", async () => {
    await expect(registerPlugins([
      {
        id: "consumer",
        requires: ["email.send"],
        register() {},
      },
    ])).rejects.toThrow('Plugin "consumer" requires missing capability "email.send".');
  });

  it("rejects duplicate plugin ids", async () => {
    await expect(registerPlugins([
      { id: "same", register() {} },
      { id: "same", register() {} },
    ])).rejects.toThrow('Duplicate plugin id "same".');
  });

  it("rejects duplicate capability providers", () => {
    const ctx = createPluginContext();

    ctx.provide("test.answer", 1);

    expect(() => ctx.provide("test.answer", 2)).toThrow(
      'Capability "test.answer" has already been provided.',
    );
  });

  it("still guards empty names at runtime for callers without types", async () => {
    // Plain-JavaScript plugins get no compile-time check, so the runtime guard
    // stays. Casts here stand in for an untyped caller.
    expect(() => createPluginContext().provide(" " as CapabilityName, 1 as never)).toThrow(
      "Capability name is required.",
    );
    expect(() => createPluginContext().require("" as CapabilityName)).toThrow(
      "Capability name is required.",
    );
    await expect(registerPlugins([
      { id: " ", register() {} },
    ])).rejects.toThrow("Plugin id is required.");
  });
});
