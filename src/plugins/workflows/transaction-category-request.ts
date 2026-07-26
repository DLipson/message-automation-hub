import type { AppConfig } from "../../config.js";
import type { HubPlugin } from "../../core/plugin-runtime.js";
import { RequestTransactionCategoryFromEmail } from "../../automations/transaction-category-request/request-from-email.js";
import { capabilities } from "../capabilities.js";

export function createTransactionCategoryRequestPlugin(config: AppConfig): HubPlugin {
  return {
    id: "transaction-category-request",
    requires: [
      capabilities.appLogger,
      capabilities.emailAutomationHandlers,
      capabilities.emailInbox,
      capabilities.emailLabeler,
      capabilities.whatsappSender,
    ],
    async register(ctx) {
      await ctx.require(capabilities.emailLabeler)
        .ensureLabels(["WA/Failed"]);

      ctx.require(
        capabilities.emailAutomationHandlers,
      ).push(new RequestTransactionCategoryFromEmail(
        ctx.require(capabilities.emailInbox),
        ctx.require(capabilities.whatsappSender),
        config.transactionCategoryRequest,
        ctx.require(capabilities.appLogger),
      ));
    },
  };
}
