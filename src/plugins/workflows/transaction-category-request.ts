import type { AppConfig } from "../../config.js";
import type { HubPlugin } from "../../core/plugin-runtime.js";
import { RequestTransactionCategoryFromEmail } from "../../automations/transaction-category-request/request-from-email.js";
import type { AppLogger } from "../../ports/app-logger.js";
import type { EmailInbox, EmailLabeler } from "../../ports/email-inbox.js";
import type { WhatsAppSender } from "../../ports/whatsapp-sender.js";
import type { EmailAutomationHandler } from "../../use-cases/process-email-automations.js";
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
      await ctx.require<EmailLabeler>(capabilities.emailLabeler)
        .ensureLabels(["WA/Failed"]);

      ctx.require<EmailAutomationHandler[]>(
        capabilities.emailAutomationHandlers,
      ).push(new RequestTransactionCategoryFromEmail(
        ctx.require<EmailInbox>(capabilities.emailInbox),
        ctx.require<WhatsAppSender>(capabilities.whatsappSender),
        config.transactionCategoryRequest,
        ctx.require<AppLogger>(capabilities.appLogger),
      ));
    },
  };
}
