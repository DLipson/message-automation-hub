# Message Automation Hub

Personal message automation experiments. The first proof of concept receives WhatsApp messages through `whatsapp-web.js` and forwards them to email through SMTP.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Create your env file outside the repo:

   ```powershell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\secrets\message-automation-hub"
   Copy-Item .env.example "$env:USERPROFILE\secrets\message-automation-hub\.env"
   ```

3. Edit:

   ```text
   C:\Users\Dovid L\secrets\message-automation-hub\.env
   ```

4. Save your SMTP app password to Windows Credential Manager:

   ```powershell
   npm run secret:set:smtp
   ```

5. Open the local settings GUI:

   ```powershell
   npm run settings
   ```

   Open the printed `http://127.0.0.1:...` URL.

6. Or run the bot directly without requesting a new pairing code:

   ```powershell
   npm run dev
   ```

7. To pair WhatsApp, start the bot from the settings GUI and click `Request Pairing Code` only when you are ready to enter the code on your phone. Then open WhatsApp:

   ```text
   Linked devices -> Link a device -> Link with phone number instead
   ```

## Settings GUI

```powershell
npm run settings
```

The GUI binds to `127.0.0.1` and uses a random token in the URL for the current session.

It can:

- edit non-secret env settings
- save or delete the SMTP password in Windows Credential Manager
- send a test email
- start and stop the bot
- request a WhatsApp pairing code from the running bot only when needed
- show bot logs and the WhatsApp pairing code

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

For Gmail, enable IMAP in Gmail settings. The app uses the same app password stored in Windows Credential Manager.

Send an email like:

```text
Subject: WA: send this

To: 972501234567

Message text goes here.
```

Rules:

- only unread emails are checked
- the subject must start with the configured prefix
- the phone number is read from the `To:` line in the email body
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

Send an email like:

```text
Subject: TXCAT: request
```

Attach a CSV with these columns:

```text
Date,Payee,Outflow,Inflow
```

The bot sends a WhatsApp message to the configured transaction category recipient. The amount uses `Outflow` when it is present and not `₪0.00`; otherwise it uses `Inflow` when it is present and not `₪0.00`. The email is marked read only after the WhatsApp send succeeds.

## WhatsApp to Email Media

Incoming WhatsApp image media is forwarded as email attachments. The app attaches up to five images from one WhatsApp message. If more images are present, the email body includes a note that additional images were not forwarded. Video is not forwarded.

## Notes

- `WHATSAPP_PHONE_NUMBER` must be digits only, with country code and no `+`.
- Gmail SMTP usually requires an app password.
- The app loads non-secret env vars from `%USERPROFILE%\secrets\message-automation-hub\.env`.
- Set `MESSAGE_HUB_ENV_FILE` if you want to use a different env file path.
- `MESSAGE_HUB_SECRET_STORE=auto` uses Windows Credential Manager on Windows and file-backed secrets on Linux.
- The SMTP password is read as `message-automation-hub/smtp-password`.
- This uses unofficial WhatsApp Web automation. Use a number you can afford to lose.

## Platform Secrets

Windows default:

```text
MESSAGE_HUB_SECRET_STORE=auto
```

uses Windows Credential Manager.

Linux default:

```text
MESSAGE_HUB_SECRET_STORE=auto
```

uses:

```text
~/secrets/message-automation-hub/secrets.json
```

You can force file storage on any platform:

```text
MESSAGE_HUB_SECRET_STORE=file
MESSAGE_HUB_SECRET_FILE=/home/opc/secrets/message-automation-hub/secrets.json
```

Use the same command to save the SMTP app password:

```powershell
npm run secret:set:smtp
```

On Linux, that writes to the configured secret file with `0600` permissions.

## Quality Checks

```powershell
npm test
npm run build
npm audit
```

## Cloud VM

See [docs/cloud-ubuntu.md](docs/cloud-ubuntu.md) for running on an Ubuntu VM with file-backed secrets, SSH-tunneled GUI access, and systemd.

For the current Google Cloud VM, generate a fresh settings GUI token and open the IAP tunnels from Windows with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\open-vm-gui.ps1
```

To request a WhatsApp phone-number pairing code from the already-running VM bot without the GUI, configure the root-only localhost control endpoint once on the VM:

```bash
cd /opt/message-automation-hub
sudo ./scripts/configure-vm-bot-control.sh
```

Then request a code only when you are ready to enter it on your phone:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\request-vm-pairing-code.ps1
```

The command opens the IAP SSH tunnel if needed, runs the VM-side `sudo /opt/message-automation-hub/scripts/request-pairing-code.sh`, and prints the JSON response containing the one-time `code`.
