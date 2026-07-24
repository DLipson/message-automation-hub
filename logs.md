# Logs

## 2026-07-24 - IMAP IDLE push notifications replace polling

- **Problem** - Email-to-WhatsApp delivery took ~4 minutes despite 30s poll interval. Gmail IMAP propagation combined with poll-only architecture caused the delay.
- **Fix** - Added `watchNewMail()` to `EmailInbox` port. `ImapEmailInbox` implements it using IMAP IDLE (persistent connection + push notifications via `exists` events + auto-reconnect loop with 25-minute maxIdleTime cycles). `EmailToWhatsAppPoller` now uses push as the primary trigger with a configurable fallback poll as safety net. Debounce coalesces rapid `exists` events to 1 second.
- **Verification** - 3 new `watchNewMail` tests (connects+opens+idles, debounced callback, stop logs out), 2 new poller tests (watcher fires processUnread, stop unwatches). All 106 tests pass, typecheck clean.

## 2026-07-24 - Derive attachment filename from content type when missing

- **Bug** - WhatsApp voice notes arrived in email as `attachment-1.bin` and were unplayable. WhatsApp doesn't set filenames on voice notes (or stickers, some audio messages), so nodemailer got `filename: undefined` and email clients defaulted to `.bin`.
- **Fix** - Added `filenameFor()` helper that generates a filename from the mime type when WhatsApp provides none (e.g. `audio/ogg; codecs=opus` → `audio.ogg`).
- **Verification** - 1 new test: "derives filename from mimetype when media has no filename". All 101 tests pass, typecheck clean.

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

## 2026-07-24 - Fix message ID extraction and add pre-processing log

- **Bug** - Media download failure logs and error notification emails showed `undefined` for message ID because `rawMessage.id._serialized` was missing on some messages (LID format). The notification email had no sender display name, no message type, and no body content for media-only messages. There was no "message received" log before the download attempt, making it hard to trace what happened.
- **Root Cause** - `tryDownloadMedia` and `attachmentsFor` accessed `rawMessage.id._serialized` without fallback. The whatsapp-web.js `id` object can lack `_serialized` on certain message formats. Neither sender label (display name), message type, nor a pre-download log line were included.
- **Fix** - Added `messageIdFor()` helper that tries `_serialized`, then inner `id`, then `JSON.stringify`, then `"unknown"`. Added `senderLabelFor()` that includes `notifyName` when available. Added `notificationTextFor()` to consistently format notification bodies with ID, sender, type, body, and time. Logged "Received message from X" before any processing starts. Applied safe ID extraction everywhere in the message handler path.
- **Verification** - 2 new tests: "logs received message before processing" and "handles missing _serialized on message id" (asserts no `undefined` in logs). All 98 tests pass, typecheck clean.

## 2026-07-24 - Reconstruct serialized message ID for LID messages

- **Bug** - Media downloads always failed on LID-formatted WhatsApp messages because `rawMessage.id._serialized` was missing. The library's `downloadMedia()` passed `undefined` to Puppeteer evaluate, causing the cryptic `r: r` error. The `downloadMediaViaPage()` fallback also failed because it got an invalid message ID.
- **Root Cause** - LID messages (`...@lid`) have an `id` object with `id` (short ID) and `fromMe` fields but missing `_serialized`. The serialized ID format is `{fromMe}_{remote}_{id}` (e.g. `false_126327990546436@lid_3EB0A1B2C3D4E5F6`).
- **Fix** - `messageIdFor()` now reconstructs the serialized ID from `id.id`, `fromMe`, and `message.from` when `_serialized` is missing. `tryDownloadMedia` skips the library's `downloadMedia()` when `_serialized` is absent (it would fail anyway) and goes straight to the page-level download with the reconstructed ID.
- **Verification** - 1 new test: "reconstructs message id from id.id and from when _serialized is missing". All 99 tests pass, typecheck clean.

## 2026-07-24 - Normalize renamed WhatsApp Web id._serialized to id.$1

- **Bug** - Media downloads and other operations failed with cryptic `r: r` error. The real error was `DataError: Failed to execute 'get' on 'IDBObjectStore': No key or key range specified.` caused by `Msg.get(undefined)`.
- **Root Cause** - WhatsApp Web renamed `id._serialized` to `id.$1` in their July 2026 update. Any code reading `id._serialized` received `undefined`, breaking all downstream operations that try to look up messages by serialized ID.
- **Fix** - Added `normalizeId()` helper that copies `$1` to `_serialized` when the latter is absent. Called at the message handler entry point, so `_serialized` is populated before our logging, media download, or the library's internal `downloadMedia()` accesses it.
- **Verification** - 1 new test: "normalizes $1 to _serialized on message id". All 100 tests pass, typecheck clean.
