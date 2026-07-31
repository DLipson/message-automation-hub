import type {
  HubPlugin, AppLogger, EmailInbox, EmailLabeler, WhatsAppSender,
} from "@message-automation/core/api/index.js";
import { RequestTransactionCategoryFromEmail } from "../automations/transaction-category-request/request-from-email.js";
import { capabilities } from "../capabilities.js";

export const plugin: HubPlugin = {
  name: "transaction-category-request",
  onLoad(ctx) {
    const cfg = ctx.config as Record<string, any>;
    if (!cfg.transactionCategoryRequest?.enabled) return;

    ctx.require<EmailLabeler>(capabilities.emailLabeler)
      .ensureLabels(["WA/Failed"]);

    const handler = new RequestTransactionCategoryFromEmail(
      ctx.require<EmailInbox>(capabilities.emailInbox),
      ctx.require<WhatsAppSender>(capabilities.whatsappSender),
      cfg.transactionCategoryRequest as {
        subjectPrefix: string;
        recipientPhoneNumber: string;
      },
      ctx.require<AppLogger>(capabilities.appLogger),
    );

    ctx.on("email.received", ({ email, batch }) => handler.handle(email, batch));
  },
};
