# Message Automation Hub

A Node.js/TypeScript message automation service that connects WhatsApp Web and email.

Current features:

- forward incoming WhatsApp text and image messages to email
- send WhatsApp messages from unread command emails
- send one image attachment from email to WhatsApp
- request transaction categories from a CSV email attachment
- manage local settings, secrets, logs, bot startup, and WhatsApp pairing from a browser GUI

This project uses unofficial WhatsApp Web automation. Use a WhatsApp number you can afford to lose.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create an env file outside the repo:

   ```bash
   mkdir -p ~/secrets/message-automation-hub
   cp .env.example ~/secrets/message-automation-hub/.env
   ```

   On Windows PowerShell:

   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\secrets\message-automation-hub"
   Copy-Item .env.example "$env:USERPROFILE\secrets\message-automation-hub\.env"
   ```

3. Edit the env file for your email account, recipients, and feature flags.

   Set `MESSAGE_HUB_ENV_FILE` if you want to use a different env file path.

4. Save your SMTP app password:

   ```bash
   npm run secret:set:smtp
   ```

5. Open the local settings GUI:

   ```bash
   npm run settings
   ```

   Open the printed `http://127.0.0.1:...` URL.

6. Or run the bot directly:

   ```bash
   npm run dev
   ```

7. To pair WhatsApp, start the bot from the settings GUI and click `Request Pairing Code` only when you are ready to enter the code on your phone. In WhatsApp, use:

   ```text
   Linked devices -> Link a device -> Link with phone number instead
   ```

## Settings GUI

```bash
npm run settings
```

The GUI binds to `127.0.0.1` and uses a random token in the URL for the current session.

It can:

- edit non-secret env settings
- save or delete the SMTP password
- send a test email
- start and stop the bot
- request a WhatsApp pairing code from the running bot only when needed
- show bot logs and the WhatsApp pairing code

## WhatsApp to Email

Incoming WhatsApp text is forwarded to the configured email recipient.

Incoming WhatsApp image media is forwarded as email attachments. The app attaches up to five images from one WhatsApp message. If more images are present, the email body includes a note that additional images were not forwarded. Video is not forwarded.

Rules:

- direct chats are forwarded
- statuses are disabled by default; enable `WHATSAPP_FORWARD_STATUSES_ENABLED=true`
- groups are disabled by default; enable `WHATSAPP_FORWARD_GROUPS_ENABLED=true`
- status and group whitelist/blacklist settings are comma-separated IDs
- set either a whitelist or a blacklist for one type, not both

## Email to WhatsApp

The reverse flow watches unread email through IMAP and sends matching emails as WhatsApp messages.

Enable it in the settings GUI:

```text
Email to WhatsApp: enabled
Command subject prefix: WA:
IMAP host: imap.gmail.com
IMAP port: 993
IMAP secure: true
IMAP user: your Gmail address
```

For Gmail, enable IMAP in Gmail settings. The app uses the same app password saved by `npm run secret:set:smtp`.

Send an email like:

```text
Subject: WA: 972501234567

Message text goes here.
```

Rules:

- only unread emails are checked
- the subject must start with the configured prefix
- subject prefixes are case-insensitive and ignore whitespace/hyphens
- the phone number is read from the rest of the subject
- the phone number part must contain at least 7 digits and no letters
- punctuation and spaces are removed from the phone number
- one image attachment can be sent with the WhatsApp message
- if multiple command emails contain images, image sends are spaced by a random 3-5 minute delay
- if one email has multiple image attachments, only the first image is sent and the sender receives a notice email when possible
- the email is marked read only after the WhatsApp send succeeds

## Transaction Category Requests

The bot can read a transaction CSV attached to an email and send a WhatsApp message asking a configured recipient what each transaction was for.

Enable it in the settings GUI:

```text
Transaction category request: enabled
Transaction category prefix: TXCAT:
Transaction category recipient: 972501234567
```

Send an email with a subject like:

```text
Subject: TXCAT
```

Subject prefixes are case-insensitive, ignore whitespace/hyphens, and do not require the trailing colon. Attach a CSV with these columns:

```text
Date,Payee,Outflow,Inflow
```

The bot sends a WhatsApp message to the configured transaction category recipient. The amount uses `Outflow` when it is present and not `NIS 0.00`; otherwise it uses `Inflow` when it is present and not `NIS 0.00`. The email is marked read only after the WhatsApp send succeeds.

## Configuration

Key settings are shown in `.env.example`.

Notes:

- `WHATSAPP_PHONE_NUMBER` must be digits only, with country code and no `+`.
- Gmail SMTP usually requires an app password.
- `MESSAGE_HUB_SECRET_STORE=auto` uses Windows Credential Manager on Windows and file-backed secrets on Linux.
- The SMTP password is read as `message-automation-hub/smtp-password`.

You can force file storage on any platform:

```text
MESSAGE_HUB_SECRET_STORE=file
MESSAGE_HUB_SECRET_FILE=/path/to/secrets.json
```

On Linux, `npm run secret:set:smtp` writes to the configured secret file with `0600` permissions.

## Quality Checks

```bash
npm test
npm run build
npm audit
```

## Cloud VM

See [docs/cloud-ubuntu.md](docs/cloud-ubuntu.md) for running on an Ubuntu VM with file-backed secrets, SSH-tunneled GUI access, and systemd.

See [docs/github-actions-iap-deploy.md](docs/github-actions-iap-deploy.md) for GitHub Actions deployment through Google Cloud Workload Identity Federation and IAP.

