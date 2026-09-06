import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  appDefaults,
  defaultEnvFilePath,
  loadRuntimeEnv,
  loadSmtpPassword,
  normalizeSmtpPassword,
  SMTP_PASSWORD_SECRET,
} from "../config.js";
import { SmtpEmailSender } from "../adapters/email/smtp-email-sender.js";
import {
  createSecretStore,
  secretStoreModes,
} from "../adapters/secrets/secret-store-factory.js";
import { EnvFileSettingsStore } from "./env-file-settings-store.js";
import { BotProcess } from "./bot-process.js";
import {
  settingsToEmailConfig,
  validateAppSettings,
  type AppSettings,
} from "./app-settings.js";

const settingsPageHtmlPath = fileURLToPath(
  new URL("./settings-page.html", import.meta.url),
);
const settingsPageHtmlTemplate = readFileSync(settingsPageHtmlPath, "utf-8");

const host = "127.0.0.1";
const maxRequestBodyBytes = 100_000;
const botStatusPollIntervalMs = 1500;
const port = Number(process.env.MESSAGE_HUB_SETTINGS_PORT ?? 0);
const token = randomBytes(24).toString("hex");
const botControlToken = randomBytes(24).toString("hex");
const botControlPort = Number(
  process.env.MESSAGE_HUB_BOT_CONTROL_PORT ?? appDefaults.botControlPort,
);
const envFilePath = process.env.MESSAGE_HUB_ENV_FILE ?? defaultEnvFilePath();
loadRuntimeEnv();
const settingsStore = new EnvFileSettingsStore(envFilePath);
const secretStore = await createSecretStore();
const botScript = process.env.NODE_ENV === "production" ? "start" : "dev";
const botProcess = new BotProcess({
  command: "npm",
  args: ["run", botScript],
  cwd: process.cwd(),
  env: {
    ...process.env,
    MESSAGE_HUB_ENV_FILE: envFilePath,
    MESSAGE_HUB_BOT_CONTROL_TOKEN: botControlToken,
    MESSAGE_HUB_BOT_CONTROL_PORT: String(botControlPort),
  },
});

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/?token=${token}`;

  console.log(`Settings GUI: ${url}`);

  if (process.env.MESSAGE_HUB_SETTINGS_SMOKE === "1") {
    server.close();
  }
});

async function route(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${host}`);

  if (request.method === "GET" && url.pathname === "/") {
    if (url.searchParams.get("token") !== token) {
      sendText(response, 403, "Forbidden");
      return;
    }

    sendHtml(response, settingsPage(token));
    return;
  }

  if (!isAuthorized(request, url)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, await readState());
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/settings") {
    const body = await readJson<{ settings: AppSettings }>(request);
    validateAppSettings(body.settings);
    await settingsStore.write(body.settings);
    sendJson(response, 200, await readState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/secrets/smtp-password") {
    const body = await readJson<{ password: string }>(request);
    await secretStore.set(SMTP_PASSWORD_SECRET, normalizeSmtpPassword(body.password));
    sendJson(response, 200, await readState());
    return;
  }

  if (
    request.method === "DELETE" &&
    url.pathname === "/api/secrets/smtp-password"
  ) {
    await secretStore.delete(SMTP_PASSWORD_SECRET);
    sendJson(response, 200, await readState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/test-email") {
    await sendTestEmail();
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bot/start") {
    sendJson(response, 200, botProcess.start());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bot/pairing-code") {
    sendJson(response, 200, await requestPairingCode());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bot/stop") {
    sendJson(response, 200, botProcess.stop());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/bot") {
    sendJson(response, 200, botProcess.snapshot());
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function readState(): Promise<{
  envFilePath: string;
  settings: AppSettings;
  secrets: { smtpPasswordConfigured: boolean };
  bot: ReturnType<BotProcess["snapshot"]>;
}> {
  return {
    envFilePath,
    settings: await settingsStore.read(),
    secrets: {
      smtpPasswordConfigured: Boolean(await secretStore.get(SMTP_PASSWORD_SECRET)),
    },
    bot: botProcess.snapshot(),
  };
}

async function sendTestEmail(): Promise<void> {
  const settings = await settingsStore.read();
  const smtpPassword = await loadSmtpPassword(secretStore);
  const config = settingsToEmailConfig(settings, smtpPassword);
  const emailSender = new SmtpEmailSender(config.smtp);

  botProcess.addLog(`Sending test email to ${config.email.to}.`);

  await emailSender.send({
    from: config.email.from,
    to: config.email.to,
    subject: "Message Automation Hub test email",
    text: "Your SMTP settings are working.",
  });

  botProcess.addLog(`Sent test email to ${config.email.to}.`);
}

async function requestPairingCode(): Promise<{ code: string }> {
  const response = await fetch(`http://127.0.0.1:${botControlPort}/pairing-code`, {
    method: "POST",
    headers: {
      "x-bot-control-token": botControlToken,
    },
  });

  const body = await response.json() as { code?: string; error?: string };

  if (!response.ok || !body.code) {
    throw new Error(body.error ?? "Bot is not ready to request a pairing code");
  }

  return { code: body.code };
}

function isAuthorized(request: IncomingMessage, url: URL): boolean {
  return (
    request.headers["x-settings-token"] === token ||
    url.searchParams.get("token") === token
  );
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  let body = "";

  for await (const chunk of request) {
    body += String(chunk);

    if (body.length > maxRequestBodyBytes) {
      throw new Error("Request body is too large");
    }
  }

  return JSON.parse(body) as T;
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

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function secretStoreOptions(): string {
  return secretStoreModes
    .map(mode => '                    <option value="' + mode + '">' + mode + '</option>')
    .join("\n");
}

function settingsPage(pageToken: string): string {
  return settingsPageHtmlTemplate
    .replaceAll("__TOKEN__", JSON.stringify(pageToken))
    .replaceAll("__SECRET_STORE_OPTIONS__", secretStoreOptions())
    .replaceAll("__POLL_INTERVAL__", String(botStatusPollIntervalMs));
}

