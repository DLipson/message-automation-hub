import type {
  HubPlugin, AppLogger, EmailInbox, EmailLabeler, EmailSender, EmailStatusMarker, WhatsAppSender,
} from "@message-automation/core/api/index.js";
import { ForwardEmailToWhatsApp } from "../use-cases/forward-email-to-whatsapp.js";
import { capabilities } from "../capabilities.js";

export const plugin: HubPlugin = {
  name: "email-command-to-whatsapp",
  onLoad(ctx) {
    const cfg = ctx.config as Record<string, any>;
    if (!cfg.emailToWhatsapp?.enabled) return;

    const emailSender = ctx.require<EmailSender>(capabilities.emailSender);

    ctx.require<EmailLabeler>(capabilities.emailLabeler)
      .ensureLabels(["WA/Sent", "WA/Delivered", "WA/Failed"]);

    const handler = new ForwardEmailToWhatsApp(
      ctx.require<EmailInbox>(capabilities.emailInbox),
      ctx.require<EmailStatusMarker>(capabilities.emailStatusMarker),
      ctx.require<WhatsAppSender>(capabilities.whatsappSender),
      {
        subjectPrefix: cfg.emailToWhatsapp.subjectPrefix as string,
        extraImageNotification: {
          sender: emailSender,
          from: cfg.email.from as string,
        },
        failureNotification: {
          sender: emailSender,
          from: cfg.email.from as string,
          to: cfg.email.to as string,
        },
      },
      ctx.require<AppLogger>(capabilities.appLogger),
    );

    ctx.on("email.received", ({ email, batch }) => handler.handle(email, batch));
  },
};
