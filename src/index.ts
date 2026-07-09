import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { RequestTransactionCategoryFromEmail } from "./automations/transaction-category-request/request-from-email.js";
import { ImapEmailInbox } from "./adapters/email/imap-email-inbox.js";
import {
  defaultWhatsAppEmailThreadStorePath,
  JsonWhatsAppEmailThreadStore,
} from "./adapters/email/json-whatsapp-email-thread-store.js";
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
import { ReplyEmailToWhatsApp } from "./use-cases/reply-email-to-whatsapp.js";

loadRuntimeEnv();

const secretStore = await createSecretStore();
const smtpPassword = await loadSmtpPassword(secretStore);
const config = loadConfig(process.env, { smtpPassword });
const logger = new ConsoleAppLogger();
const threadStore = new JsonWhatsAppEmailThreadStore(
  defaultWhatsAppEmailThreadStorePath(process.env),
  { messageIdDomain: config.email.messageIdDomain },
);

const emailSender = new SmtpEmailSender(config.smtp);
const forwardMessageToEmail = new ForwardMessageToEmail(
  emailSender,
  { ...config.email, threadStore },
  logger,
);
const whatsapp = new WhatsAppWebChannel(config.whatsapp);

whatsapp.onMessage(message => forwardMessageToEmail.handle(message));

const whatsappStart = whatsapp.start();
startControlServer(whatsapp, process.env);
await whatsappStart;

const emailAutomationHandlers: EmailAutomationHandler[] = [];

if (config.emailToWhatsapp.enabled || config.transactionCategoryRequest.enabled) {
  const inbox = new ImapEmailInbox(config.imap);

  if (config.emailToWhatsapp.enabled) {
    emailAutomationHandlers.push(
      new ReplyEmailToWhatsApp(inbox, whatsapp, threadStore, logger, {
        ignoreFrom: config.email.from,
      }),
    );
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

function startControlServer(
  whatsappChannel: WhatsAppWebChannel,
  env: NodeJS.ProcessEnv,
): void {
  const port = Number(env.MESSAGE_HUB_BOT_CONTROL_PORT ?? 0);
  const token = env.MESSAGE_HUB_BOT_CONTROL_TOKEN;

  if (!port || !token) {
    return;
  }

  const server = createServer(async (request, response) => {
    try {
      await routeControlRequest(whatsappChannel, token, request, response);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Bot control server listening on 127.0.0.1:${port}.`);
  });
}

async function routeControlRequest(
  whatsappChannel: WhatsAppWebChannel,
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.headers["x-bot-control-token"] !== token) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  if (request.method === "POST" && url.pathname === "/pairing-code") {
    const code = await whatsappChannel.requestPairingCode();
    sendJson(response, 200, { code });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}
