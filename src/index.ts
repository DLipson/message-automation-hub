import { SmtpEmailSender } from "./adapters/email/smtp-email-sender.js";
import { OsCredentialSecretStore } from "./adapters/secrets/os-credential-secret-store.js";
import { WhatsAppWebChannel } from "./adapters/whatsapp/whatsapp-web-channel.js";
import { loadConfig, loadRuntimeEnv, loadSmtpPassword } from "./config.js";
import { ForwardMessageToEmail } from "./use-cases/forward-message-to-email.js";

loadRuntimeEnv();

const secretStore = new OsCredentialSecretStore();
const smtpPassword = await loadSmtpPassword(secretStore);
const config = loadConfig(process.env, { smtpPassword });

const emailSender = new SmtpEmailSender(config.smtp);
const forwardMessageToEmail = new ForwardMessageToEmail(emailSender, config.email);
const whatsapp = new WhatsAppWebChannel(config.whatsapp);

whatsapp.onMessage(message => forwardMessageToEmail.handle(message));

await whatsapp.start();
