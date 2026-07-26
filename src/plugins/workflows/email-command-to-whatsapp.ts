import type { AppConfig } from "../../config.js";
import type { HubPlugin } from "../../core/plugin-runtime.js";
import type { AppLogger } from "../../ports/app-logger.js";
import type { EmailInbox, EmailLabeler, EmailStatusMarker } from "../../ports/email-inbox.js";
import type { EmailSender } from "../../ports/email-sender.js";
import type { WhatsAppSender } from "../../ports/whatsapp-sender.js";
import { ForwardEmailToWhatsApp } from "../../use-cases/forward-email-to-whatsapp.js";
import type { EmailAutomationHandler } from "../../use-cases/process-email-automations.js";
import { capabilities } from "../capabilities.js";

export function createEmailCommandToWhatsAppPlugin(config: AppConfig): HubPlugin {
  return {
    id: "email-command-to-whatsapp",
    requires: [
      capabilities.appLogger,
      capabilities.emailAutomationHandlers,
      capabilities.emailInbox,
      capabilities.emailLabeler,
      capabilities.emailSender,
      capabilities.emailStatusMarker,
      capabilities.whatsappSender,
    ],
    async register(ctx) {
      const emailSender = ctx.require<EmailSender>(capabilities.emailSender);

      await ctx.require<EmailLabeler>(capabilities.emailLabeler)
        .ensureLabels(["WA/Sent", "WA/Delivered", "WA/Failed"]);

      ctx.require<EmailAutomationHandler[]>(
        capabilities.emailAutomationHandlers,
      ).push(new ForwardEmailToWhatsApp(
        ctx.require<EmailInbox>(capabilities.emailInbox),
        ctx.require<EmailStatusMarker>(capabilities.emailStatusMarker),
        ctx.require<WhatsAppSender>(capabilities.whatsappSender),
        {
          subjectPrefix: config.emailToWhatsapp.subjectPrefix,
          extraImageNotification: {
            sender: emailSender,
            from: config.email.from,
          },
          failureNotification: {
            sender: emailSender,
            from: config.email.from,
            to: config.email.to,
          },
        },
        ctx.require<AppLogger>(capabilities.appLogger),
      ));
    },
  };
}
