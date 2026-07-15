import { defaultEnvFilePath } from "../config.js";
import type { AppConfig } from "../config.js";
import type { HubPlugin } from "../core/plugin-runtime.js";
import { ImapEmailInbox } from "../adapters/email/imap-email-inbox.js";
import {
  defaultWhatsAppEmailThreadStorePath,
  JsonWhatsAppEmailThreadStore,
} from "../adapters/email/json-whatsapp-email-thread-store.js";
import { SmtpEmailSender } from "../adapters/email/smtp-email-sender.js";
import type { AppLogger } from "../ports/app-logger.js";
import type { EmailSender } from "../ports/email-sender.js";
import type { EmailAutomationHandler } from "../use-cases/process-email-automations.js";
import { WhatsAppWebChannel } from "../adapters/whatsapp/whatsapp-web-channel.js";
import { capabilities } from "./capabilities.js";
import { dirname, join } from "node:path";

export function createLoggerPlugin(logger: AppLogger): HubPlugin {
  return {
    id: "logger",
    register(ctx) {
      ctx.provide(capabilities.appLogger, logger);
    },
  };
}

export function createEmailPlugin(config: AppConfig, env: NodeJS.ProcessEnv = process.env): HubPlugin {
  return {
    id: "email",
    register(ctx) {
      ctx.provide(capabilities.emailSender, new SmtpEmailSender(config.smtp));
      ctx.provide(capabilities.emailInbox, new ImapEmailInbox({ ...config.imap, checkpointPath: env.IMAP_CHECKPOINT_FILE ?? join(dirname(env.MESSAGE_HUB_ENV_FILE ?? defaultEnvFilePath()), "imap-checkpoint.json") }));
      ctx.provide<EmailAutomationHandler[]>(
        capabilities.emailAutomationHandlers,
        [],
      );
    },
  };
}

export function createThreadStorePlugin(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
): HubPlugin {
  return {
    id: "thread-store",
    register(ctx) {
      ctx.provide(capabilities.threadStore, new JsonWhatsAppEmailThreadStore(
        defaultWhatsAppEmailThreadStorePath(env),
        { messageIdDomain: config.email.messageIdDomain },
      ));
    },
  };
}

export function createWhatsAppWebPlugin(config: AppConfig): HubPlugin {
  return {
    id: "whatsapp-web",
    register(ctx) {
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
            }
          : {}),
      });

      ctx.provide(capabilities.whatsappChannel, whatsapp);
      ctx.provide(capabilities.whatsappInbound, whatsapp);
      ctx.provide(capabilities.whatsappSender, whatsapp);
      ctx.provide(capabilities.whatsappChatSender, whatsapp);
    },
  };
}
