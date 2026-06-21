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

5. Run the app:

   ```powershell
   npm run dev
   ```

6. When a pairing code appears, open WhatsApp:

   ```text
   Linked devices -> Link a device -> Link with phone number instead
   ```

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
```
