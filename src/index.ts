import { SmtpEmailSender } from "./adapters/email/smtp-email-sender.js";
import { WhatsAppWebChannel } from "./adapters/whatsapp/whatsapp-web-channel.js";
import { loadConfig } from "./config.js";
import { ForwardMessageToEmail } from "./use-cases/forward-message-to-email.js";

const config = loadConfig();

const emailSender = new SmtpEmailSender(config.smtp);
const forwardMessageToEmail = new ForwardMessageToEmail(emailSender, config.email);
const whatsapp = new WhatsAppWebChannel(config.whatsapp);

whatsapp.onMessage(message => forwardMessageToEmail.handle(message));

await whatsapp.start();
