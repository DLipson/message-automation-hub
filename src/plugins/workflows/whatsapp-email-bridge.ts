import type { AppConfig } from "../../config.js";
import type { HubPlugin } from "../../api/index.js";
import { capabilities } from "../../api/index.js";
import { ForwardMessageToEmail } from "../../use-cases/forward-message-to-email.js";
import { ReplyEmailToWhatsApp } from "../../use-cases/reply-email-to-whatsapp.js";
import type { AppLogger } from "../../ports/app-logger.js";
import type { EmailInbox } from "../../ports/email-inbox.js";
import type { EmailSender } from "../../ports/email-sender.js";
import type { InboundChannel } from "../../ports/inbound-channel.js";
import type { WhatsAppChatSender } from "../../ports/whatsapp-sender.js";
import type { WhatsAppEmailThreadStore } from "../../use-cases/whatsapp-email-thread-store.js";

export function createWhatsAppEmailBridgePlugin(config: AppConfig): HubPlugin {
  return {
    name: "whatsapp-email-bridge",
    onLoad(ctx) {
      const logger = ctx.require<AppLogger>(capabilities.appLogger);
      const threadStore = ctx.require<WhatsAppEmailThreadStore>(
        capabilities.threadStore,
      );
      const forwardMessageToEmail = new ForwardMessageToEmail(
        ctx.require<EmailSender>(capabilities.emailSender),
        { ...config.email, threadStore },
        logger,
      );

      ctx.require<InboundChannel>(capabilities.whatsappInbound)
        .onMessage(message => forwardMessageToEmail.handle(message));

      if (!config.emailToWhatsapp.enabled) {
        return;
      }

      const replyHandler = new ReplyEmailToWhatsApp(
        ctx.require<EmailInbox>(capabilities.emailInbox),
        ctx.require<WhatsAppChatSender>(capabilities.whatsappChatSender),
        threadStore,
        logger,
        {
          ignoreFrom: config.email.from,
          failureNotification: {
            sender: ctx.require<EmailSender>(capabilities.emailSender),
            from: config.email.from,
            to: config.email.to,
          },
        },
      );

      ctx.on("email.received", ({ email, batch }) => replyHandler.handle(email, batch));
    },
  };
}
