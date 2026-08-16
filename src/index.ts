import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSecretStore } from "./adapters/secrets/secret-store-factory.js";
import { loadConfig, loadRuntimeEnv, loadSmtpPassword } from "./config.js";
import { registerPlugins } from "./core/plugin-runtime.js";
import { EmailToWhatsAppPoller } from "./email-to-whatsapp-poller.js";
import { errorMessage } from "./errors.js";
import { capabilities } from "./api/index.js";
import {
  createEmailPlugin,
  createLoggerPlugin,
  createThreadStorePlugin,
  createWhatsAppWebPlugin,
} from "./plugins/providers.js";
import { createWhatsAppEmailBridgePlugin } from "./plugins/workflows/whatsapp-email-bridge.js";
import type { WhatsAppPairing } from "./ports/whatsapp-sender.js";
import { reportStartupFailure } from "./startup.js";
import { ProcessEmailAutomations } from "./use-cases/process-email-automations.js";

try {
  await start();
} catch (error) {
  reportStartupFailure(error);
  process.exit(1);
}

async function start(): Promise<void> {
  loadRuntimeEnv();

  const secretStore = await createSecretStore();
  const smtpPassword = await loadSmtpPassword(secretStore);
  const config = loadConfig(process.env, { smtpPassword });
  const logger = console;
  const pluginContext = await registerPlugins([
    createLoggerPlugin(logger),
    createEmailPlugin(config, process.env),
    createThreadStorePlugin(config, process.env),
    createWhatsAppWebPlugin(config, process.env),
    createWhatsAppEmailBridgePlugin(config, process.env),
  ]);
  const whatsapp = pluginContext.require(capabilities.whatsappInbound);

  const whatsappStart = whatsapp.start();
  startControlServer(
    pluginContext.require(capabilities.whatsappPairing),
    process.env,
  );
  try {
    await whatsappStart;
  } catch (error) {
    console.error(`WhatsApp startup failed: ${errorMessage(error)}`);
    await logWhatsAppSessionState();
  }

  if (!pluginContext.hasListeners("email.received")) {
    return;
  }

  const inbox = pluginContext.require(capabilities.emailInbox);
  const poller = new EmailToWhatsAppPoller(
    new ProcessEmailAutomations(inbox, pluginContext),
    inbox,
    config.emailToWhatsapp.pollIntervalMs,
  );

  await poller.start();
  console.log("Email automation polling is enabled.");
}

async function logWhatsAppSessionState(): Promise<void> {
  const sessionDir = "./.wwebjs_auth";
  try {
    const entries = await readdir(sessionDir, { withFileTypes: true, recursive: true });
    const notable = entries.filter(entry => /Singleton|\.lock$|^Default$|^session/i.test(entry.name));
    console.error(`WhatsApp session dir ${sessionDir}: ${entries.length} entries; notable: ${notable.map(e => `${e.parentPath}/${e.name}`).join(", ") || "none"}`);
  } catch (error) {
    console.error(`WhatsApp session dir ${sessionDir} unreadable: ${errorMessage(error)}`);
  }
}

function startControlServer(
  pairing: WhatsAppPairing,
  env: NodeJS.ProcessEnv,
): void {
  const port = Number(env.MESSAGE_HUB_BOT_CONTROL_PORT ?? 0);
  const token = env.MESSAGE_HUB_BOT_CONTROL_TOKEN;

  if (!port || !token) {
    return;
  }

  const server = createServer(async (request, response) => {
    try {
      await routeControlRequest(pairing, token, request, response);
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
  pairing: WhatsAppPairing,
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
    const code = await pairing.requestPairingCode();
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
