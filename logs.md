# Logs

## 2026-07-22 - Reply email failure notification

- **Change** - `ReplyEmailToWhatsApp` now sends an email notification when forwarding a reply to WhatsApp fails. Added `failureNotification` config option with `sender`, `from`, `to`. Wired via `whatsapp-email-bridge.ts`.
- **Verification** - Updated existing test to expect notification instead of rejecting.

## 2026-07-22 - Error notifications + improved logging for WhatsAppWebChannel

- **Problem** - WhatsApp media download failures were silently dropping attachments (returned `[]`). Handler crashes were logged with a cryptic message. The IMAP client logged "Connection not available" when `logout()` was called on a dropped connection.
- **Changes** -
  - Added `errorNotification` config to `WhatsAppWebChannel` (like `readyNotification`). Fires email on handler crash AND media download failure with full message context (ID, from, body, time, error).
  - `tryDownloadMedia` now logs message ID and sender in the error message.
  - `downloadMediaViaPage` now checks `pupPage` for null before using it, logs when page is unavailable.
  - `attachmentsFor` logs when media is unavailable and fires notification.
  - All three `client.logout()` calls in `ImapEmailInbox` are now wrapped in try-catch so connection-drop errors don't propagate.
  - `WhatsAppWebChannel` error notification wired in `providers.ts`.
- **Verification** - 4 new tests (message context logging, notification on handler crash, notification on media failure, no notification when unconfigured). All 96 tests pass. Typecheck clean.



## 2026-06-21 - GUI log copying and bot restart cleanup

- **Bug** - The GUI log panel refreshed while selecting text, making logs hard to copy. Stopping and restarting the bot could fail with `The browser is already running` because the WhatsApp browser process kept the auth profile locked.
- **Root Cause** - The GUI replaced the log `<pre>` contents on every polling cycle. The Stop action killed only the direct wrapper process, leaving child Node/Chromium processes running.
- **Fix** - Log rendering now skips DOM replacement while the user is selecting log text and includes a Copy Logs button. Bot stopping now terminates the full process tree and ignores late exit events from an intentionally stopped child process.
- **Verification** - Added `BotProcess` regression tests for process-tree stopping and late child exits, then ran the full test suite and TypeScript build.

## 2026-06-21 - Missing GUI forwarding logs

- **Bug** - The GUI logs did not show when WhatsApp messages were forwarded to email, when email commands were detected and forwarded to WhatsApp, or when test emails were sent.
- **Root Cause** - The forwarding use cases completed silently, and the settings server only surfaced test-email success through a transient UI notice.
- **Fix** - Added an `AppLogger` port, wired runtime logging to stdout for bot events, and added GUI-side log entries for test email sends.
- **Verification** - Added use-case and `BotProcess` tests for the new log events, then ran the full test suite and TypeScript build.

## 2026-06-29 - Ignored emails flooded bot logs

- **Bug** - The bot journal was flooded with repeated `Detected unread email` lines for unrelated unread inbox messages.
- **Root Cause** - `ForwardEmailToWhatsApp` logged every unread email before checking whether the email matched the configured WhatsApp command subject prefix.
- **Fix** - Command parsing now happens before detection logging, so unrelated unread emails are skipped silently and only matching command emails are logged.
- **Verification** - Added a regression assertion that ignored emails produce no logs, confirmed it failed before the fix, then ran the targeted test, full test suite, and TypeScript build successfully.

## 2026-07-15 - Reply email includes quoted original text

- **Bug** - When replying to a forwarded WhatsApp email via Gmail, the reply sent back to WhatsApp included the standard email quoting (`On ... wrote:` and `>`-prefixed lines) along with the user's actual reply text.
- **Root Cause** - `replyTextFor` only split on `--- Reply above this line ---` and took the text before it, but Gmail's quoting appears before that marker in the email body.
- **Fix** - After extracting text before the reply marker, `replyTextFor` now scans for common email quoting patterns (`On ... wrote:`, `---Original Message---`, `>`-prefixed lines) and strips everything from the first such line onward.
- **Verification** - All 90 existing tests pass; no new tests added for the quoting patterns.

## 2026-07-15 - Deferred email labeling with delivery ack tracking

- **Change** - `sendMessage`/`sendImage` now return `SentMessage` with a `delivery` promise that resolves to `'sent'`, `'delivered'`, or `'error'` based on `message_ack` event. Gmail IMAP label `WA/Delivered` added.
- **How it works** - A FIFO queue of delivery resolvers is pushed before each `client.sendMessage()` call. The `message_create` event (fired by `Msg.on('add', ...)` which fires regardless of the LID `Msg.get()` bug) pops the queue and sets up a `message_ack` listener. Ack=2 resolves `'delivered'`, ack=-1 resolves `'error'`, and a timeout resolves `'sent'` (message was sent to server even if device ack never arrives).
- **Labeling deferred** - Before: `markSent` called immediately after send. After: `ForwardEmailToWhatsApp.handle()` fires `sentMsg.delivery.then(...)` and returns without blocking. The email is labeled once the ack settles, with no label visible in the meantime.
- **Verification** - All 91 tests pass (one new IMAP test, updated fake implementations for the new return types).

## 2026-07-15 - WhatsApp voice note media download crash

- **Bug** - Sending a voice note via WhatsApp caused `WhatsAppWebChannel.attachmentsFor` to crash with `r: r` from Puppeteer's `evaluate`, failing the entire message handler and dropping the message.
- **Root Cause** - `rawMessage.downloadMedia()` from whatsapp-web.js v1.34.7 passes `msg.type` (`'ptt'`) to `downloadAndMaybeDecrypt`, which expects a media type (`'audio'`, `'image'`, etc.). The `downloadAndMaybeDecrypt` call throws for `'ptt'`, and the error propagates out of `page.evaluate()` as an uncatchable puppeteer error.
- **Fix** - Replaced the single `downloadMedia()` call with a two-step fallback: first try the library's `downloadMedia()`, and if it fails, retry via a direct `page.evaluate()` that maps `msg.type === 'ptt'` to `'audio'` for the download manager. If both fail, the message is processed without attachments (instead of crashing).
- **Verification** - All 92 tests pass. New regression test for media download failure.
