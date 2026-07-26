import type { AppConfig } from "../../config.js";
import type { HubPlugin } from "../../core/plugin-runtime.js";
import { ForwardMessageToEmail } from "../../use-cases/forward-message-to-email.js";
import { ReplyEmailToWhatsApp } from "../../use-cases/reply-email-to-whatsapp.js";
import { capabilities } from "../capabilities.js";

export function createWhatsAppEmailBridgePlugin(config: AppConfig): HubPlugin {
  return {
    id: "whatsapp-email-bridge",
    requires: [
      capabilities.appLogger,
      capabilities.emailAutomationHandlers,
      capabilities.emailInbox,
      capabilities.emailSender,
      capabilities.threadStore,
      capabilities.whatsappChatSender,
      capabilities.whatsappInbound,
    ],
    register(ctx) {
      const logger = ctx.require(capabilities.appLogger);
      const threadStore = ctx.require(
        capabilities.threadStore,
      );
      const forwardMessageToEmail = new ForwardMessageToEmail(
        ctx.require(capabilities.emailSender),
        { ...config.email, threadStore },
        logger,
      );

      ctx.require(capabilities.whatsappInbound)
        .onMessage(message => forwardMessageToEmail.handle(message));

      if (!config.emailToWhatsapp.enabled) {
        return;
      }

      ctx.require(
        capabilities.emailAutomationHandlers,
      ).push(new ReplyEmailToWhatsApp(
        ctx.require(capabilities.emailInbox),
        ctx.require(capabilities.whatsappChatSender),
        threadStore,
        logger,
        {
          ignoreFrom: config.email.from,
          failureNotification: {
            sender: ctx.require(capabilities.emailSender),
            from: config.email.from,
            to: config.email.to,
          },
        },
      ));
    },
  };
}
