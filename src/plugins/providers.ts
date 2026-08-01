import { defaultEnvFilePath } from "../config.js";
import type { AppConfig } from "../config.js";
import type { HubPlugin } from "../api/index.js";
import { capabilities } from "../api/index.js";
import { ImapEmailInbox } from "../adapters/email/imap-email-inbox.js";
import {
  defaultWhatsAppEmailThreadStorePath,
  JsonWhatsAppEmailThreadStore,
} from "../adapters/email/json-whatsapp-email-thread-store.js";
import { SmtpEmailSender } from "../adapters/email/smtp-email-sender.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailSender } from "../ports/email-sender.js";
import { WhatsAppWebChannel } from "../adapters/whatsapp/whatsapp-web-channel.js";
import { dirname, join } from "node:path";

export function createLoggerPlugin(logger: AppLogger): HubPlugin {
  return {
    name: "logger",
    onLoad(ctx) {
      ctx.provide(capabilities.appLogger, logger);
    },
  };
}

export function createEmailPlugin(config: AppConfig, env: NodeJS.ProcessEnv = process.env): HubPlugin {
  return {
    name: "email",
    onLoad(ctx) {
      const inbox = new ImapEmailInbox({
        ...config.imap,
        checkpointPath: env.IMAP_CHECKPOINT_FILE ?? join(
          dirname(env.MESSAGE_HUB_ENV_FILE ?? defaultEnvFilePath()),
          "imap-checkpoint.json",
        ),
      });

      ctx.provide(capabilities.emailSender, new SmtpEmailSender(config.smtp));
      ctx.provide(capabilities.emailInbox, inbox);
      ctx.provide(capabilities.emailStatusMarker, inbox);
      ctx.provide(capabilities.emailLabeler, inbox);
    },
  };
}

export function createThreadStorePlugin(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
): HubPlugin {
  return {
    name: "thread-store",
    onLoad(ctx) {
      ctx.provide(capabilities.threadStore, new JsonWhatsAppEmailThreadStore(
        defaultWhatsAppEmailThreadStorePath(env),
        { messageIdDomain: config.email.messageIdDomain },
      ));
    },
  };
}

export function createWhatsAppWebPlugin(config: AppConfig): HubPlugin {
  return {
    name: "whatsapp-web",
    onLoad(ctx) {
      const emailSender = ctx.has(capabilities.emailSender)
        ? ctx.require<EmailSender>(capabilities.emailSender)
        : undefined;

      const whatsapp = new WhatsAppWebChannel({
        ...config.whatsapp,
        ...(emailSender
          ? {
              readyNotification: {
                sender: emailSender,
                from: config.email.from,
                to: config.email.to,
              },
              errorNotification: {
                sender: emailSender,
                from: config.email.from,
                to: config.email.to,
              },
            }
          : {}),
      });

      ctx.provide(capabilities.whatsappInbound, whatsapp);
      ctx.provide(capabilities.whatsappSender, whatsapp);
      ctx.provide(capabilities.whatsappChatSender, whatsapp);
      ctx.provide(capabilities.whatsappPairing, whatsapp);
    },
  };
}
