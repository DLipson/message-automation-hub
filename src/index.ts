import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSecretStore } from "./adapters/secrets/secret-store-factory.js";
import { WhatsAppWebChannel } from "./adapters/whatsapp/whatsapp-web-channel.js";
import { loadConfig, loadRuntimeEnv, loadSmtpPassword } from "./config.js";
import { registerPlugins } from "./core/plugin-runtime.js";
import { EmailToWhatsAppPoller } from "./email-to-whatsapp-poller.js";
import { capabilities } from "./plugins/capabilities.js";
import {
  createEmailPlugin,
  createLoggerPlugin,
  createThreadStorePlugin,
  createWhatsAppWebPlugin,
} from "./plugins/providers.js";
import { createEmailCommandToWhatsAppPlugin } from "./plugins/workflows/email-command-to-whatsapp.js";
import { createTransactionCategoryRequestPlugin } from "./plugins/workflows/transaction-category-request.js";
import { createWhatsAppEmailBridgePlugin } from "./plugins/workflows/whatsapp-email-bridge.js";
import type { EmailInbox } from "./ports/email-inbox.js";
import type { EmailAutomationHandler } from "./use-cases/process-email-automations.js";
import { ProcessEmailAutomations } from "./use-cases/process-email-automations.js";

loadRuntimeEnv();

const secretStore = await createSecretStore();
const smtpPassword = await loadSmtpPassword(secretStore);
const config = loadConfig(process.env, { smtpPassword });
const logger = console;
const pluginContext = await registerPlugins([
  createLoggerPlugin(logger),
  createEmailPlugin(config, process.env),
  createThreadStorePlugin(config, process.env),
  createWhatsAppWebPlugin(config),
  createWhatsAppEmailBridgePlugin(config),
  ...(config.emailToWhatsapp.enabled
    ? [createEmailCommandToWhatsAppPlugin(config)]
    : []),
  ...(config.transactionCategoryRequest.enabled
    ? [createTransactionCategoryRequestPlugin(config)]
    : []),
]);
const whatsapp = pluginContext.require<WhatsAppWebChannel>(
  capabilities.whatsappChannel,
);

const whatsappStart = whatsapp.start();
startControlServer(whatsapp, process.env);
await whatsappStart;

const emailAutomationHandlers = pluginContext.require<EmailAutomationHandler[]>(
  capabilities.emailAutomationHandlers,
);

if (emailAutomationHandlers.length > 0) {
  const inbox = pluginContext.require<EmailInbox>(capabilities.emailInbox);
  const poller = new EmailToWhatsAppPoller(
    new ProcessEmailAutomations(inbox, emailAutomationHandlers),
    inbox,
    config.emailToWhatsapp.pollIntervalMs,
  );

  await poller.start();
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
