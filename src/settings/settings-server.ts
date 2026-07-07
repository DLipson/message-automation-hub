import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { defaultEnvFilePath, loadRuntimeEnv, loadSmtpPassword } from "../config.js";
import { SmtpEmailSender } from "../adapters/email/smtp-email-sender.js";
import { createSecretStore } from "../adapters/secrets/secret-store-factory.js";
import { EnvFileSettingsStore } from "./env-file-settings-store.js";
import { SecretStatus } from "./secret-status.js";
import { BotProcess } from "./bot-process.js";
import { settingsToEmailConfig, type AppSettings } from "./app-settings.js";

const host = "127.0.0.1";
const port = Number(process.env.MESSAGE_HUB_SETTINGS_PORT ?? 0);
const token = randomBytes(24).toString("hex");
const botControlToken = randomBytes(24).toString("hex");
const botControlPort = Number(process.env.MESSAGE_HUB_BOT_CONTROL_PORT ?? 8788);
const envFilePath = process.env.MESSAGE_HUB_ENV_FILE ?? defaultEnvFilePath();
loadRuntimeEnv();
const settingsStore = new EnvFileSettingsStore(envFilePath);
const secretStore = await createSecretStore();
const secretStatus = new SecretStatus(secretStore);
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
    await settingsStore.write(body.settings);
    sendJson(response, 200, await readState());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/secrets/smtp-password") {
    const body = await readJson<{ password: string }>(request);
    await secretStatus.setSmtpPassword(body.password);
    sendJson(response, 200, await readState());
    return;
  }

  if (
    request.method === "DELETE" &&
    url.pathname === "/api/secrets/smtp-password"
  ) {
    await secretStatus.deleteSmtpPassword();
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
      smtpPasswordConfigured: await secretStatus.hasSmtpPassword(),
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

    if (body.length > 100_000) {
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

function settingsPage(pageToken: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Message Automation Hub</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f7f9;
        --panel: #ffffff;
        --text: #17202a;
        --muted: #5e6b78;
        --line: #d9dee5;
        --primary: #176b5f;
        --primary-hover: #11554b;
        --danger: #a23535;
        --danger-hover: #812b2b;
        --focus: #2f7de1;
        font-family: "Segoe UI", system-ui, sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
      }

      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 28px 18px 36px;
      }

      header {
        display: flex;
        justify-content: space-between;
        gap: 18px;
        align-items: flex-start;
        margin-bottom: 22px;
      }

      h1 {
        font-size: 26px;
        line-height: 1.2;
        margin: 0 0 6px;
        font-weight: 650;
      }

      h2 {
        font-size: 17px;
        margin: 0 0 16px;
      }

      p {
        margin: 0;
      }

      .muted {
        color: var(--muted);
        font-size: 14px;
      }

      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(340px, 0.9fr);
        gap: 16px;
      }

      section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 18px;
      }

      .stack {
        display: grid;
        gap: 16px;
      }

      form {
        display: grid;
        gap: 14px;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 600;
      }

      input,
      select {
        width: 100%;
        min-height: 38px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--text);
        background: #fff;
        padding: 8px 10px;
        font: inherit;
      }

      input:focus,
      select:focus,
      button:focus {
        outline: 2px solid var(--focus);
        outline-offset: 2px;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }

      .section-heading {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        margin-bottom: 16px;
      }

      .section-heading h2 {
        margin: 0;
      }

      button {
        border: 1px solid transparent;
        border-radius: 6px;
        min-height: 38px;
        padding: 8px 12px;
        font: inherit;
        font-weight: 650;
        cursor: pointer;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.62;
      }

      .primary {
        background: var(--primary);
        color: #fff;
      }

      .primary:hover:not(:disabled) {
        background: var(--primary-hover);
      }

      .secondary {
        background: #fff;
        color: var(--text);
        border-color: var(--line);
      }

      .danger {
        background: var(--danger);
        color: #fff;
      }

      .danger:hover:not(:disabled) {
        background: var(--danger-hover);
      }

      .status {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 4px 10px;
        border: 1px solid var(--line);
        border-radius: 999px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 650;
        background: #fff;
      }

      .notice {
        min-height: 22px;
        color: var(--muted);
        font-size: 14px;
      }

      .notice.error {
        color: var(--danger);
      }

      pre {
        min-height: 260px;
        max-height: 460px;
        overflow: auto;
        margin: 0;
        padding: 12px;
        border-radius: 6px;
        background: #121820;
        color: #dbe7f3;
        font: 13px/1.45 Consolas, "Cascadia Mono", monospace;
        white-space: pre-wrap;
      }

      @media (max-width: 820px) {
        header,
        .layout,
        .grid {
          grid-template-columns: 1fr;
        }

        header {
          display: grid;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Message Automation Hub</h1>
          <p class="muted" id="env-path"></p>
        </div>
        <span class="status" id="bot-status">Loading</span>
      </header>

      <div class="layout">
        <div class="stack">
          <section>
            <h2>Settings</h2>
            <form id="settings-form">
              <div class="grid">
                <label>
                  WhatsApp phone number
                  <input name="whatsappPhoneNumber" autocomplete="off">
                </label>
                <label>
                  Secret store
                  <select name="messageHubSecretStore">
                    <option value="auto">auto</option>
                    <option value="windows-credential">windows-credential</option>
                    <option value="file">file</option>
                  </select>
                </label>
                <label>
                  Secret file
                  <input name="messageHubSecretFile" autocomplete="off">
                </label>
                <label>
                  SMTP host
                  <input name="smtpHost" autocomplete="off">
                </label>
                <label>
                  SMTP port
                  <input name="smtpPort" inputmode="numeric" autocomplete="off">
                </label>
                <label>
                  SMTP secure
                  <select name="smtpSecure">
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                </label>
                <label>
                  SMTP user
                  <input name="smtpUser" autocomplete="username">
                </label>
                <label>
                  Email from
                  <input name="emailFrom" autocomplete="email">
                </label>
                <label>
                  Email to
                  <input name="emailTo" autocomplete="email">
                </label>
                <label>
                  Email to WhatsApp
                  <select name="emailToWhatsappEnabled">
                    <option value="false">disabled</option>
                    <option value="true">enabled</option>
                  </select>
                </label>
                <label>
                  Command subject prefix
                  <input name="emailToWhatsappSubjectPrefix" autocomplete="off">
                </label>
                <label>
                  Poll seconds
                  <input name="emailToWhatsappPollSeconds" inputmode="numeric" autocomplete="off">
                </label>
                <label>
                  Transaction category request
                  <select name="transactionCategoryRequestEnabled">
                    <option value="false">disabled</option>
                    <option value="true">enabled</option>
                  </select>
                </label>
                <label>
                  Transaction category prefix
                  <input name="transactionCategoryRequestSubjectPrefix" autocomplete="off">
                </label>
                <label>
                  Transaction category recipient
                  <input name="transactionCategoryRequestRecipientPhoneNumber" autocomplete="off">
                </label>
                <label>
                  IMAP host
                  <input name="imapHost" autocomplete="off">
                </label>
                <label>
                  IMAP port
                  <input name="imapPort" inputmode="numeric" autocomplete="off">
                </label>
                <label>
                  IMAP secure
                  <select name="imapSecure">
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                </label>
                <label>
                  IMAP user
                  <input name="imapUser" autocomplete="username">
                </label>
              </div>
              <div class="actions">
                <button class="primary" type="submit">Save Settings</button>
                <button class="secondary" id="test-email" type="button">Send Test Email</button>
                <span class="notice" id="settings-notice"></span>
              </div>
            </form>
          </section>

          <section>
            <h2>SMTP Password</h2>
            <form id="secret-form">
              <label>
                New SMTP app password
                <input name="password" type="password" autocomplete="new-password">
              </label>
              <div class="actions">
                <button class="primary" type="submit">Save Password</button>
                <button class="danger" id="delete-secret" type="button">Delete Password</button>
                <span class="status" id="secret-status">Loading</span>
                <span class="notice" id="secret-notice"></span>
              </div>
            </form>
          </section>
        </div>

        <div class="stack">
          <section>
            <h2>Run</h2>
            <div class="actions">
              <button class="primary" id="start-bot" type="button">Start Bot</button>
              <button class="secondary" id="request-pairing-code" type="button">Request Pairing Code</button>
              <button class="secondary" id="stop-bot" type="button">Stop Bot</button>
              <span class="notice" id="run-notice"></span>
            </div>
          </section>

          <section>
            <div class="section-heading">
              <h2>Logs</h2>
              <button class="secondary" id="copy-logs" type="button">Copy Logs</button>
            </div>
            <pre id="logs"></pre>
          </section>
        </div>
      </div>
    </main>

    <script>
      const token = ${JSON.stringify(pageToken)};
      const form = document.querySelector("#settings-form");
      const secretForm = document.querySelector("#secret-form");
      const settingsNotice = document.querySelector("#settings-notice");
      const secretNotice = document.querySelector("#secret-notice");
      const runNotice = document.querySelector("#run-notice");
      const logs = document.querySelector("#logs");
      let latestLogText = "";

      async function api(path, options = {}) {
        const response = await fetch(path, {
          ...options,
          headers: {
            "content-type": "application/json",
            "x-settings-token": token,
            ...(options.headers ?? {}),
          },
        });

        const body = await response.json();

        if (!response.ok) {
          throw new Error(body.error ?? "Request failed");
        }

        return body;
      }

      function readSettings() {
        return {
          whatsappPhoneNumber: form.whatsappPhoneNumber.value.trim(),
          messageHubSecretStore: form.messageHubSecretStore.value,
          messageHubSecretFile: form.messageHubSecretFile.value.trim(),
          smtpHost: form.smtpHost.value.trim(),
          smtpPort: form.smtpPort.value.trim(),
          smtpSecure: form.smtpSecure.value === "true",
          smtpUser: form.smtpUser.value.trim(),
          emailFrom: form.emailFrom.value.trim(),
          emailTo: form.emailTo.value.trim(),
          emailToWhatsappEnabled: form.emailToWhatsappEnabled.value === "true",
          emailToWhatsappSubjectPrefix: form.emailToWhatsappSubjectPrefix.value.trim(),
          emailToWhatsappPollSeconds: form.emailToWhatsappPollSeconds.value.trim(),
          transactionCategoryRequestEnabled: form.transactionCategoryRequestEnabled.value === "true",
          transactionCategoryRequestSubjectPrefix: form.transactionCategoryRequestSubjectPrefix.value.trim(),
          transactionCategoryRequestRecipientPhoneNumber: form.transactionCategoryRequestRecipientPhoneNumber.value.trim(),
          imapHost: form.imapHost.value.trim(),
          imapPort: form.imapPort.value.trim(),
          imapSecure: form.imapSecure.value === "true",
          imapUser: form.imapUser.value.trim(),
        };
      }

      function renderState(state) {
        document.querySelector("#env-path").textContent = state.envFilePath;
        document.querySelector("#secret-status").textContent =
          state.secrets.smtpPasswordConfigured ? "configured" : "missing";
        renderBot(state.bot);

        for (const [key, value] of Object.entries(state.settings)) {
          if (key === "smtpSecure" || key === "emailToWhatsappEnabled" || key === "transactionCategoryRequestEnabled" || key === "imapSecure") {
            form[key].value = String(value);
          } else {
            form[key].value = value ?? "";
          }
        }
      }

      function renderBot(bot) {
        document.querySelector("#bot-status").textContent = bot.status;
        const isStartingOrRunning = bot.status === "starting" || bot.status === "running";
        document.querySelector("#start-bot").disabled = isStartingOrRunning;
        document.querySelector("#request-pairing-code").disabled = bot.status !== "running";
        document.querySelector("#stop-bot").disabled = bot.status === "stopped";

        const nextLogText = bot.logs.join("\\n");
        latestLogText = nextLogText;

        if (logs.textContent === nextLogText || isSelectingLogs()) {
          return;
        }

        const shouldStickToBottom =
          logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 8;

        logs.textContent = nextLogText;

        if (shouldStickToBottom) {
          logs.scrollTop = logs.scrollHeight;
        }
      }

      function isSelectingLogs() {
        const selection = window.getSelection();

        if (!selection || selection.isCollapsed) {
          return false;
        }

        return logs.contains(selection.anchorNode) || logs.contains(selection.focusNode);
      }

      async function refresh() {
        const state = await api("/api/state");
        renderState(state);
      }

      form.addEventListener("submit", async event => {
        event.preventDefault();
        settingsNotice.className = "notice";
        settingsNotice.textContent = "Saving...";

        try {
          const state = await api("/api/settings", {
            method: "PUT",
            body: JSON.stringify({ settings: readSettings() }),
          });
          renderState(state);
          settingsNotice.textContent = "Saved.";
        } catch (error) {
          settingsNotice.className = "notice error";
          settingsNotice.textContent = error.message;
        }
      });

      secretForm.addEventListener("submit", async event => {
        event.preventDefault();
        secretNotice.className = "notice";
        secretNotice.textContent = "Saving...";

        try {
          const state = await api("/api/secrets/smtp-password", {
            method: "POST",
            body: JSON.stringify({ password: secretForm.password.value }),
          });
          secretForm.password.value = "";
          renderState(state);
          secretNotice.textContent = "Saved.";
        } catch (error) {
          secretNotice.className = "notice error";
          secretNotice.textContent = error.message;
        }
      });

      document.querySelector("#delete-secret").addEventListener("click", async () => {
        secretNotice.className = "notice";
        secretNotice.textContent = "Deleting...";

        try {
          const state = await api("/api/secrets/smtp-password", {
            method: "DELETE",
          });
          renderState(state);
          secretNotice.textContent = "Deleted.";
        } catch (error) {
          secretNotice.className = "notice error";
          secretNotice.textContent = error.message;
        }
      });

      document.querySelector("#test-email").addEventListener("click", async () => {
        settingsNotice.className = "notice";
        settingsNotice.textContent = "Sending...";

        try {
          await api("/api/test-email", { method: "POST" });
          settingsNotice.textContent = "Test email sent.";
        } catch (error) {
          settingsNotice.className = "notice error";
          settingsNotice.textContent = error.message;
        }
      });

      document.querySelector("#start-bot").addEventListener("click", async () => {
        runNotice.className = "notice";
        runNotice.textContent = "Starting...";

        try {
          renderBot(await api("/api/bot/start", { method: "POST" }));
          runNotice.textContent = "";
        } catch (error) {
          runNotice.className = "notice error";
          runNotice.textContent = error.message;
        }
      });

      document.querySelector("#request-pairing-code").addEventListener("click", async () => {
        runNotice.className = "notice";
        runNotice.textContent = "Requesting pairing code...";

        try {
          const result = await api("/api/bot/pairing-code", { method: "POST" });
          runNotice.textContent = "Pairing code: " + result.code;
          await refresh();
        } catch (error) {
          runNotice.className = "notice error";
          runNotice.textContent = error.message;
        }
      });

      document.querySelector("#stop-bot").addEventListener("click", async () => {
        runNotice.className = "notice";
        runNotice.textContent = "Stopping...";

        try {
          renderBot(await api("/api/bot/stop", { method: "POST" }));
          runNotice.textContent = "";
        } catch (error) {
          runNotice.className = "notice error";
          runNotice.textContent = error.message;
        }
      });

      document.querySelector("#copy-logs").addEventListener("click", async () => {
        runNotice.className = "notice";
        runNotice.textContent = "Copying logs...";

        try {
          await navigator.clipboard.writeText(latestLogText);
          runNotice.textContent = "Logs copied.";
        } catch (error) {
          runNotice.className = "notice error";
          runNotice.textContent = "Could not copy logs.";
        }
      });

      setInterval(async () => {
        try {
          renderBot(await api("/api/bot"));
        } catch {
        }
      }, 1500);

      refresh().catch(error => {
        settingsNotice.className = "notice error";
        settingsNotice.textContent = error.message;
      });
    </script>
  </body>
</html>`;
}

