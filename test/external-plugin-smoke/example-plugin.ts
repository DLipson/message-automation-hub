import type { HubPlugin } from "@message-automation/core/api/index.js";
import { capabilities } from "@message-automation/core/api/index.js";
import {
  registerPlugins,
} from "@message-automation/core/core/plugin-runtime.js";

type ExchangeRate = {
  currency: string;
  rate: number;
};

declare module "@message-automation/core/core/plugin-runtime.js" {
  interface Capabilities {
    "exchangerate.get": ExchangeRate;
  }
}

const exchangeRatePlugin: HubPlugin = {
  id: "exchange-rate",
  requires: ["app.logger"],
  register(ctx) {
    ctx.provide("exchangerate.get", { currency: "USD", rate: 1.0 });
    ctx.require("app.logger").info("exchange-rate plugin registered.");
    ctx.on("email.received", async ({ email }) => {
      void email.id;
      return false;
    });
  },
};

await registerPlugins([exchangeRatePlugin]);