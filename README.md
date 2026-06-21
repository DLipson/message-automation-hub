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

## Notes

- `WHATSAPP_PHONE_NUMBER` must be digits only, with country code and no `+`.
- Gmail SMTP usually requires an app password.
- The app loads non-secret env vars from `%USERPROFILE%\secrets\message-automation-hub\.env`.
- Set `MESSAGE_HUB_ENV_FILE` if you want to use a different env file path.
- The SMTP password is read from Windows Credential Manager as `message-automation-hub/smtp-password`.
- This uses unofficial WhatsApp Web automation. Use a number you can afford to lose.

## Quality Checks

```powershell
npm test
npm run build
npm audit
```
