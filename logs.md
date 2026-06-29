# Logs

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
