# Message Automation Hub

Personal message automation experiments. The first proof of concept receives WhatsApp messages through `whatsapp-web.js` and forwards them to email through SMTP.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Create `.env` from `.env.example`.

3. Run the app:

   ```powershell
   npm run dev
   ```

4. When a pairing code appears, open WhatsApp:

   ```text
   Linked devices -> Link a device -> Link with phone number instead
   ```

## Notes

- `WHATSAPP_PHONE_NUMBER` must be digits only, with country code and no `+`.
- Gmail SMTP usually requires an app password.
- This uses unofficial WhatsApp Web automation. Use a number you can afford to lose.

## Quality Checks

```powershell
npm test
npm run build
```
