import type { AppConfig } from "../../config.js";
import type { HubPlugin } from "../../api/index.js";
import { capabilities } from "../../api/index.js";
import {
  defaultPendingGroupInviteStorePath,
  JsonPendingGroupInviteStore,
} from "../../adapters/email/json-pending-group-invite-store.js";
import { AcceptGroupInviteByEmail } from "../../use-cases/accept-group-invite-by-email.js";
import { ForwardMessageToEmail } from "../../use-cases/forward-message-to-email.js";
import { ReplyEmailToWhatsApp } from "../../use-cases/reply-email-to-whatsapp.js";
import type { AppLogger } from "../../ports/app-logger.js";

export function createWhatsAppEmailBridgePlugin(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): HubPlugin {
  return {
    id: "whatsapp-email-bridge",
    register(ctx) {
      const logger = ctx.require(capabilities.appLogger);
      const threadStore = ctx.require(capabilities.threadStore);
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

      const whatsappInbound = ctx.require(capabilities.whatsappInbound);

      const inviteHandler = new AcceptGroupInviteByEmail(
        ctx.require(capabilities.emailInbox),
        ctx.require(capabilities.emailSender),
        threadStore,
        new JsonPendingGroupInviteStore(defaultPendingGroupInviteStorePath(env)),
        ctx.require(capabilities.whatsappChatSender),
        {
          ownerEmail: config.email.to,
          from: config.email.from,
          messageIdDomain: config.email.messageIdDomain,
        },
        logger,
      );

      whatsappInbound.onGroupInvite(async (inviteV4, fromId, senderLabel) => {
        await inviteHandler.handleCardInvite(inviteV4, fromId, senderLabel);
      });

      ctx.on("email.received", ({ email, batch }) => inviteHandler.handle(email, batch));

      const replyHandler = new ReplyEmailToWhatsApp(
        ctx.require(capabilities.emailInbox),
        ctx.require(capabilities.whatsappChatSender),
        threadStore,
        logger,
        {
          failureNotification: {
            sender: ctx.require(capabilities.emailSender),
            from: config.email.from,
            to: config.email.to,
          },
        },
      );

      ctx.on("email.received", ({ email, batch }) => replyHandler.handle(email, batch));
    },
  };
}