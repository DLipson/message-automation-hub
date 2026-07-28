import type { AppConfig } from "../../config.js";
import type { HubPlugin } from "../../core/plugin-runtime.js";
import { ForwardEmailToWhatsApp } from "../../use-cases/forward-email-to-whatsapp.js";
import { capabilities } from "../capabilities.js";

export function createEmailCommandToWhatsAppPlugin(config: AppConfig): HubPlugin {
  return {
    id: "email-command-to-whatsapp",
    requires: [
      capabilities.appLogger,
      capabilities.emailInbox,
      capabilities.emailLabeler,
      capabilities.emailSender,
      capabilities.emailStatusMarker,
      capabilities.whatsappSender,
    ],
    async register(ctx) {
      const emailSender = ctx.require(capabilities.emailSender);

      await ctx.require(capabilities.emailLabeler)
        .ensureLabels(["WA/Sent", "WA/Delivered", "WA/Failed"]);

      const handler = new ForwardEmailToWhatsApp(
        ctx.require(capabilities.emailInbox),
        ctx.require(capabilities.emailStatusMarker),
        ctx.require(capabilities.whatsappSender),
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
        ctx.require(capabilities.appLogger),
      );

      ctx.on("email.received", ({ email, batch }) => handler.handle(email, batch));
    },
  };
}
