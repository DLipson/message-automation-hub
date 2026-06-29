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

6. Or run the bot directly:

   ```powershell
   npm run dev
   ```

7. When a pairing code appears, open WhatsApp:

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
- the email is marked read only after the WhatsApp send succeeds

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

