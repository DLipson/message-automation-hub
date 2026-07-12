import { describe, expect, it } from "vitest";
import {
  createPluginContext,
  registerPlugins,
  type HubPlugin,
} from "../src/core/plugin-runtime.js";

describe("plugin runtime", () => {
  it("registers plugins in order and exposes provided capabilities", async () => {
    const calls: string[] = [];
    const provider: HubPlugin = {
      id: "provider",
      register(ctx) {
        calls.push("provider");
        ctx.provide("answer", 42);
      },
    };
    const consumer: HubPlugin = {
      id: "consumer",
      requires: ["answer"],
      register(ctx) {
        calls.push(`consumer:${ctx.require<number>("answer")}`);
      },
    };

    const ctx = await registerPlugins([provider, consumer]);

    expect(calls).toEqual(["provider", "consumer:42"]);
    expect(ctx.require("answer")).toBe(42);
  });

  it("waits for async plugin registration before registering dependents", async () => {
    const provider: HubPlugin = {
      id: "async-provider",
      async register(ctx) {
        await Promise.resolve();
        ctx.provide("ready", true);
      },
    };
    const consumer: HubPlugin = {
      id: "consumer",
      requires: ["ready"],
      register(ctx) {
        ctx.provide("observed", ctx.require("ready"));
      },
    };

    const ctx = await registerPlugins([provider, consumer]);

    expect(ctx.require("observed")).toBe(true);
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

    ctx.provide("email.send", {});

    expect(() => ctx.provide("email.send", {})).toThrow(
      'Capability "email.send" has already been provided.',
    );
  });

  it("rejects empty ids and capability names", async () => {
    expect(() => createPluginContext().provide(" ", {})).toThrow(
      "Capability name is required.",
    );
    expect(() => createPluginContext().require("")).toThrow(
      "Capability name is required.",
    );
    await expect(registerPlugins([
      { id: " ", register() {} },
    ])).rejects.toThrow("Plugin id is required.");
  });
});
