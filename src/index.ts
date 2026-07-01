import { ImapEmailInbox } from "./adapters/email/imap-email-inbox.js";
import { SmtpEmailSender } from "./adapters/email/smtp-email-sender.js";
import { ConsoleAppLogger } from "./adapters/logging/console-app-logger.js";
import { createSecretStore } from "./adapters/secrets/secret-store-factory.js";
import { WhatsAppWebChannel } from "./adapters/whatsapp/whatsapp-web-channel.js";
import { loadConfig, loadRuntimeEnv, loadSmtpPassword } from "./config.js";
import { EmailToWhatsAppPoller } from "./email-to-whatsapp-poller.js";
import { ForwardEmailToWhatsApp } from "./use-cases/forward-email-to-whatsapp.js";
import { ForwardMessageToEmail } from "./use-cases/forward-message-to-email.js";

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

if (config.emailToWhatsapp.enabled) {
  const inbox = new ImapEmailInbox(config.imap);
  const forwardEmailToWhatsApp = new ForwardEmailToWhatsApp(inbox, whatsapp, {
    subjectPrefix: config.emailToWhatsapp.subjectPrefix,
    extraImageNotification: {
      sender: emailSender,
      from: config.email.from,
    },
  }, logger);
  const poller = new EmailToWhatsAppPoller(
    forwardEmailToWhatsApp,
    config.emailToWhatsapp.pollIntervalMs,
  );

  poller.start();
  console.log("Email to WhatsApp forwarding is enabled.");
}
