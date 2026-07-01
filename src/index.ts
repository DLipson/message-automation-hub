import { RequestTransactionCategoryFromEmail } from "./automations/transaction-category-request/request-from-email.js";
import { ImapEmailInbox } from "./adapters/email/imap-email-inbox.js";
import { SmtpEmailSender } from "./adapters/email/smtp-email-sender.js";
import { ConsoleAppLogger } from "./adapters/logging/console-app-logger.js";
import { createSecretStore } from "./adapters/secrets/secret-store-factory.js";
import { WhatsAppWebChannel } from "./adapters/whatsapp/whatsapp-web-channel.js";
import { loadConfig, loadRuntimeEnv, loadSmtpPassword } from "./config.js";
import { EmailToWhatsAppPoller } from "./email-to-whatsapp-poller.js";
import { ForwardEmailToWhatsApp } from "./use-cases/forward-email-to-whatsapp.js";
import { ForwardMessageToEmail } from "./use-cases/forward-message-to-email.js";
import type { EmailAutomationHandler } from "./use-cases/process-email-automations.js";
import { ProcessEmailAutomations } from "./use-cases/process-email-automations.js";

loadRuntimeEnv();

const secretStore = await createSecretStore();
const smtpPassword = await loadSmtpPassword(secretStore);
const config = loadConfig(process.env, { smtpPassword });
const logger = new ConsoleAppLogger();

const emailSender = new SmtpEmailSender(config.smtp);
const forwardMessageToEmail = new ForwardMessageToEmail(
  emailSender,
  config.email,
  logger,
);
const whatsapp = new WhatsAppWebChannel(config.whatsapp);

whatsapp.onMessage(message => forwardMessageToEmail.handle(message));

await whatsapp.start();

const emailAutomationHandlers: EmailAutomationHandler[] = [];

if (config.emailToWhatsapp.enabled || config.transactionCategoryRequest.enabled) {
  const inbox = new ImapEmailInbox(config.imap);

  if (config.emailToWhatsapp.enabled) {
    emailAutomationHandlers.push(new ForwardEmailToWhatsApp(inbox, whatsapp, {
      subjectPrefix: config.emailToWhatsapp.subjectPrefix,
      extraImageNotification: {
        sender: emailSender,
        from: config.email.from,
      },
    }, logger));
  }

  if (config.transactionCategoryRequest.enabled) {
    emailAutomationHandlers.push(new RequestTransactionCategoryFromEmail(
      inbox,
      whatsapp,
      config.transactionCategoryRequest,
      logger,
    ));
  }

  const poller = new EmailToWhatsAppPoller(
    new ProcessEmailAutomations(inbox, emailAutomationHandlers),
    config.emailToWhatsapp.pollIntervalMs,
  );

  poller.start();
  console.log("Email automation polling is enabled.");
}
