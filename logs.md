# Logs

## 2026-08-09 - Stage deploys now pull a prebuilt GHCR image instead of building on the VM

- **Why** - Every stage deploy was failing at the *first* `git` call on the VM: the Debian 13 image ships no git, `set -euo pipefail` killed the startup script before `docker compose` was ever reached. Diagnosed via Cloud Logging (`logName:"syslog" AND "message-hub-stage-deploy"`) once correct IAM was granted to the VM's service account (`1023328382892-compute@developer.gserviceaccount.com`); swap + deadline bumps (`ee09dad`, `e5ed1df`) were never the true blocker.
- **Fix - move the build off the VM entirely** - New `build-stage-image` job (stage only) builds with Buildx and pushes `ghcr.io/dlipson/message-automation-hub:stage-<sha>` using the GITHUB_TOKEN (`packages: write`). `deploy-stage` now `needs: [verify, build-stage-image]`, and its startup script only installs Docker (if missing), writes `docker-compose.yml` (tag baked in via sed from the runner checkout) plus `.env.example`, then `docker compose pull && docker compose up -d`. All git clone/swap/npm-build logic removed from the stage path.
- **Repo is public** - Verified with `gh repo view` (`isPrivate:false`); `.dockerignore` blocks `.env`, `**/.env`, `secrets`, `.wwebjs_auth`. Public GHCR image leaks nothing extra and needs no credentials on the VM.
- **broke once** - First push failed `denied: not_found: owner not found`: I had mistyped the GHCR namespace as `dlipsom` (extra `m`); the real lowercase owner is `dlipson`. Fixed in both `deploy.yml` tags and `docker-compose.yml`.
- **Verification** - Run `31328587996` green end-to-end: verify, image build+push, deploy-stage success with `Stage deploy startup script complete for 57b8bdb...` in the VM log; container started via docker compose.
- **Ponytail note** - Keeping master's systemd/npm path untouched; only stage switches to image-based deploys.

## 2026-08-02 - Accept WhatsApp group invite cards (`groups_v4_invite`) by email reply

- **Feature** - Card invites now flow through the same email-reply acceptance as links. A `groups_v4_invite` WhatsApp message (no link text) is intercepted by the adapter's message handler and surfaced via a new `onGroupInvite(inviteV4, fromId, senderLabel)` inbound callback instead of being dropped by the forward pipeline as an empty-body message. The bridge plugin routes it through `AcceptGroupInviteByEmail.handleCardInvite`, which records the full `inviteV4` data against the inviter's thread token and emails the owner ("Group: <name>, Invited by: <sender>, Reply with exactly: accept"). Replying `accept` calls wwebjs `client.acceptGroupV4Invite(inviteV4)`.
- **Why the full record, not just the code** - wwebjs `acceptInvite` runs the public-link job (`WAWebGroupInviteJob.joinGroupViaInvite(code)`) while cards need the V4 job (`WAWebGroupInviteV4Job.joinGroupViaInviteV4(code, exp, groupId, fromId)`, which throws `'Expired invite code'` when `inviteCodeExp == 0`). The V4 data is carried through the pending store so the accept path has everything without a live message object.
- **Port changes** - `WhatsAppChatSender` gained `acceptGroupV4Invite(inviteV4): Promise<{ status: number }>` plus the `WhatsAppGroupInviteV4` type; `InboundChannel` gained `onGroupInvite`. Implementers: the adapter (real) and `FakeWhatsApp` in `test/reply-email-to-whatsapp.test.ts` + `test/accept-group-invite-by-email.test.ts` (stubs). `InboundChannel` has no other implementers (grep-confirmed).
- **Store shape** - `PendingGroupInviteStore.put(token, invite)` now takes a details object (`{ inviteCode? }` or `{ inviteV4? }`, exactly one) instead of a bare code string; JSON store updated (same file, replace-per-token).
- **Security boundary** - Unchanged from the link flow: only replies whose `from` matches `config.email.to` are accepted; non-owner replies are consumed and marked processed.
- **Verification** - 4 new use-case tests (card record+confirm, accept by card, accept failure keeps pending, non-owner ignore) + 1 new adapter test (card intercepted by `onGroupInvite`, not forwarded). 151 tests pass, `tsc --noEmit` clean. Committed on `feat/accept-group-invite`.

## 2026-08-02 - Accept WhatsApp group invites by email reply

- **Feature** - The hub now accepts WhatsApp group invites when the owner replies `accept` to an invite email. Flow: an invite **link** (`https://chat.whatsapp.com/<code>`) is detected either in a WhatsApp-DM message forwarded to email (source A, matched to the existing thread token) or in a direct email to the hub (source B, fresh token). The hub emails the owner a confirmation ("Reply with exactly: accept") and records a pending invite keyed by a thread token (file-backed JSON, restart-proof). Replying `accept` calls wwebjs `client.acceptInvite(code)`; the result (chat id or error) is emailed back. Any other reply gets a nudge and the invite stays pending.
- **Security boundary** - Acceptance only when the reply's `from` matches `config.email.to` (the owner). Non-owner replies are consumed and marked processed, never accepted.
- **Port change** - `acceptInvite(inviteCode): Promise<string>` added to `WhatsAppChatSender`. Implementers (grep-confirmed before editing): `src/adapters/whatsapp/whatsapp-web-channel.ts` (real, via wwebjs) and `FakeWhatsApp` in `test/reply-email-to-whatsapp.test.ts` (stub).
- **Ordering matters** - The invite handler is registered on `email.received` *before* `ReplyEmailToWhatsApp`, because `emit` stops at the first handler that returns `true` — so an `accept` reply is consumed and never forwarded to WhatsApp as a chat message.
- **Wiring** - `createWhatsAppEmailBridgePlugin(config, env)` now takes env (mirrors the providers pattern) to resolve the pending-invite store path (`PENDING_GROUP_INVITE_STORE_FILE` or beside the env file).
- **ponytail: deferred** - `groups_v4_invite` cards (no link text, need `acceptGroupV4Invite` on the message object) are not handled; invite links only. Single pending invite per token; a second invite to the same thread replaces the first. No TTL on pending invites.
- **Verification** - 8 new tests in `test/accept-group-invite-by-email.test.ts` (direct-email record+confirm, accept by subject token, accept by references, non-accept nudge, non-owner ignore, accept failure keeps pending, source-A thread token, unrelated email falls through). 154 tests pass, `tsc --noEmit` clean. Committed as 4 logical commits on `feat/accept-group-invite`.


## 2026-08-02 - Split repo into two independent GitHub repositories

- **Goal** - Complete the split started 2026-07-31: core (`message-automation-hub`, now `@message-automation/core` at the repo root) and plugins (`message-automation-plugins`, new public repo) are now two standalone repos. Plugins depend on core for **types only** via a git dependency, like `@types/vscode`.
- **Repo restructure** - `git mv core/src ./src`, `git mv core/test ./test`; root `deploy/docs/scripts/.github/tsconfig*` already duplicated core's copies, so `core/` and `plugins/` were removed. Root `package.json` is now `@message-automation/core` (single package, no workspaces), lockfile regenerated. `core-plugins-split` was merged into `master` (fast-forwardable after checking the 2 master-only commits were a self-cancelling add+revert) and the branch deleted.
- **Plugins repo** - Created via `gh repo create DLipson/message-automation-plugins --public`, history extracted with `git subtree split --prefix=plugins -b plugins-split`, pushed as `master`. `package.json` git-depends on `@message-automation/core: github:DLipson/message-automation-hub`.
- **Runtime-free test harness** - `plugins/test/helpers/run-with-email-handler.ts` no longer imports core runtime (`createPluginContext` + `ProcessEmailAutomations`); it is a local loop (fetchUnread → `handler.handle(email, batch)`, catches throws → `markFailed` if the inbox is an `EmailStatusMarker`). `plugins/test/helpers/fake-plugin-runtime.ts` is a minimal local `createPluginContext`/`registerPlugins` implementing just `provide`/`require`/`has`/`on`/`emit`/`hasListeners`/`config`/`formatError`/`parseSubjectCommand`. `bundled-plugins.test.ts` rewritten to drop the bridge legs (core covers the bridge in its own tests); it now registers only the two plugins-repo workflows.
- **Git-dep build bug (fixed)** - core's `prepare` script (`npm run build`) fails inside the plugins repo because npm does not install a git dependency's devDependencies (`@types/mailparser`, `@types/nodemailer`). Fix: core's `package.json` `exports` now points the `types` condition at the source files (`./src/api/index.ts`, `./src/core/plugin-runtime.ts`) instead of `./dist/**/*.d.ts`. Plugins are `import type` only, so tsc resolves straight from source and no build is needed. The `default` conditions still point at `dist` for runtime consumers.
- **Gotcha** - npm caches git dependencies; after pushing a fix to core, clear with `npm cache clean --force` plus deleting `node_modules`/`package-lock.json` or the stale core checkout persists.
- **Verification** - core: 135 tests pass, `tsc --noEmit` clean. plugins: 19 tests pass, `tsc --noEmit` clean. Both pushed to GitHub.
- **Pending** - Smoke-test `docker compose build` with the new flat layout; the local NetFree override files (`Dockerfile.netfree`, `docker-compose.override.yml`, `netfree-ca.crt`) are gitignored and still in place.

## 2026-07-31 - Split monorepo into core + plugins workspaces

- **Goal** - Restructure the single package into two independent npm workspaces (`core/`, `plugins/`) as the first phase toward a separate plugins repo and dockerization. Plugin code no longer imports runtime code from core; plugins import types only.
- **Plugin contract** - `core/src/api/index.ts` defines `PluginContext` (provide/require/has/on/emit/hasListeners + `config`), `HubPlugin` (`{ name, onLoad(ctx) }`), capability name constants, and re-exports the domain/port types plugins need. The previous `{ id, requires, register }` shape and `requires` validation were dropped.
- **Internal implementation** - `core/src/core/plugin-runtime.ts` keeps the strongly-typed `Capabilities`/`EventMap`, now with: `registerPlugins(plugins, contextOrConfig?)` accepting either a pre-built context (host provides capabilities, then loads plugins) or a config object (creates a fresh context). `ctx.formatError` returns the short message (for notification bodies), NOT the full stack — the full-stack `formatError` stays in `core/src/errors.ts` and `plugins/src/utils.ts`.
- **Plugin-side standalone-ness** - `plugins/src/capabilities.ts` and `plugins/src/utils.ts` are local copies of capability names and pure helpers (`formatError`, `parseSubjectCommand`, `isImageAttachment`); the plugin runtime never imports these from core.
- **Bugs fixed during the split**
  - `registerPlugins` silently dropped the provided context (created a fresh empty one), so every capability lookup threw at `onLoad`. Root cause: signature took config, callers passed a context. Fix: accept either.
  - `PluginContext.on` in the public API typed handlers as `void | Promise<void>`, but the event loop returns `boolean` to signal handled/stop — 10 typecheck failures. Fixed the API type to `boolean | Promise<boolean>`.
  - `require<T>` returned `unknown` without explicit type args (API is loosely typed by design); all call sites in core and plugins now pass the port type explicitly.
  - `@message-automation/core/api/index.js` didn't resolve because core had no `exports` map; added one pointing at `./src/api/index.ts` (all plugin imports are `import type`, so only tsc needs it).
  - npm rejected `workspace:*` devDep (`EUNSUPPORTEDPROTOCOL`); switched to `^0.1.0`, npm auto-links the workspace.
- **Verification** - 135 core + 21 plugin tests pass, `tsc --noEmit` clean in both, `tsc -p tsconfig.build.json` (core) clean.
- **Cleanup after** - Root `src/` and `test/` (stale copies fully superseded by `core/` + `plugins/`) were removed in a follow-up commit. Also made the branch switch: the split work moved from `event-system` to `core-plugins-split`; `event-system` was reset back to before the split.

## 2026-07-26 - IMAP connection storm, restart loop, and leaked sockets

Three defects stacked into one outage: the bot crash-looped 37 times against Gmail with `3 NO [ALERT] Too many simultaneous connections`, never reaching a successful login.

- **Trigger** - Gmail caps an account at 15 simultaneous IMAP connections and reaps lingering ones slowly. A restart while the previous process's IDLE connection was still registered server-side put the account over the cap.
- **Defect 1: transient failure classified as permanent.** imapflow sets `authenticationFailed: true` on *any* AUTHENTICATE failure, including "Too many simultaneous connections", which clears on its own. `isAuthenticationFailure` trusted that flag, so the IDLE watcher treated a temporary rate limit as rotated credentials and gave up permanently. Fixed by keying only on `serverResponseCode === "AUTHENTICATIONFAILED"` — an allowlist of the one code known to be permanent, so an unrecognized failure stays retryable. Note imapflow *has* an `AuthenticationFailure` class internally but does not export it; do not reach for it.
- **Defect 2: abandoned clients were never closed.** imapflow closes its own socket on socket errors and on connect/greeting timeouts, but **not** when the server refuses AUTHENTICATE — that path only rejects the connect promise (`imap-flow.js`, the `startSession()` catch inside `initialOK`), and no `close`/`end` listener is attached until after the session is up. So each retry left a live socket: up to 5 per `connectClient()` call, feeding the exact limit it was retrying against. `watchNewMail` leaked the same way and worse, retrying indefinitely, and also abandoned a healthy client on every 25-minute `maxIdleTime` reconnect. Every abandoned client now goes through `closeQuietly()`.
- **Defect 3: nothing stopped the restart loop.** `Restart=on-failure` with `RestartSec=10` and no start limit restarted every 10s forever, and each attempt added connections. Now `RestartSec=60` with `StartLimitBurst=5` over `StartLimitIntervalSec=600`, so the unit lands in `failed` after five tries instead of hammering the server. This is the load-bearing fix for a *permanent* failure such as rotated credentials, which fails instantly with no backoff for the retry logic to absorb.
- **Verification** - 5 new tests, red first (`close()` called 0 times in all five): retried transient failure, exhausted attempts, permanently rejected credentials, failed watcher connect, and the IDLE-cycle reconnect. 151 tests pass, `tsc --noEmit` clean.
- **Watch out** - Fixing the leak exposed a latent hang: `stop()` can only unblock `idle()` via `currentClient`, so a client that connects after stopping begins would IDLE forever with nobody to resolve it. The watcher now checks `stopped` after `mailboxOpen` and refuses to enter IDLE.
- **Not caught locally, and would not have been.** With stale credentials you fail before AUTHENTICATE; with real ones you add load to the same account. The failure is a connection budget plus a restart loop, not a code path. What *is* worth having is `test/module-imports.test.ts` (added 663b57a) for import-time breakage, and eventually a boot-with-fakes harness — the typed capability registry checks a capability's type, not that anything provides it.

## 2026-07-26 - Untyped capability registry hid a startup crash

- **Bug** - `PluginContext.require<T>(name: string): T` tied its type parameter to nothing: the body was `capabilities.get(key) as T`. The name/type pairing existed only by convention, asserted by hand at 23 call sites. Two workflows exploited this to pull `"email.receive"` out as `EmailInbox & EmailStatusMarker & { ensureLabels }` — only the first of which the `EmailInbox` port declares.
- **Impact** - A plugin providing a port-compliant `EmailInbox` (the exact thing the port invites) compiled cleanly, passed `requires` validation because the *name* was registered, then died at startup on `inbox.ensureLabels is not a function`. Latent because core happens to provide `ImapEmailInbox`, which has the method. `index.ts` had the same shape: it required `"whatsapp.channel"` as the concrete `WhatsAppWebChannel` and called `requestPairingCode()`, a method no port declared, exposed over localhost HTTP by the bot control server.
- **Fix** -
  - `EmailLabeler` port (`ensureLabels`) and separate capabilities for it and `EmailStatusMarker`, so an inbox that cannot label simply does not provide them and a dependent workflow fails fast with a clear message.
  - `WhatsAppPairing` port for `requestPairingCode`. `whatsapp.channel` had no consumer left and was removed.
  - `ForwardEmailToWhatsApp` takes its inbox and status marker as separate constructor dependencies instead of one intersection.
  - `Capabilities` interface maps every capability name to its contract; `provide`/`require`/`has` are keyed on `keyof Capabilities`. All 23 casts deleted — the type now comes from the name.
- **Verification** - Red first: the new fail-fast test failed with the real `inbox.ensureLabels is not a function`, and the type assertions failed as *"Unused '@ts-expect-error' directive"* (proving the old API accepted every mistake) before turning green. 112 tests pass, `tsc --noEmit` clean, also clean under `--noUnusedLocals` after deleting 25 type imports the casts had been keeping alive.
- **Note** - Compile-time enforcement of the type tests depends on `test/**` staying in `tsconfig.json`'s `include`. If tests ever leave the typecheck, the `@ts-expect-error` assertions stop asserting anything.

## 2026-07-24 - IMAP IDLE push notifications replace polling

- **Problem** - Email-to-WhatsApp delivery took ~4 minutes despite 30s poll interval. Gmail IMAP propagation combined with poll-only architecture caused the delay.
- **Fix** - Added `watchNewMail()` to `EmailInbox` port. `ImapEmailInbox` implements it using IMAP IDLE (persistent connection + push notifications via `exists` events + auto-reconnect loop with 25-minute maxIdleTime cycles). `EmailToWhatsAppPoller` now uses push as the primary trigger with a configurable fallback poll as safety net. Debounce coalesces rapid `exists` events to 1 second.
- **Follow-up fixes:**
  - Auth failure no longer retries every 5s forever: a permanent credential rejection stops the watch loop immediately. Transient errors use exponential backoff (5s → 300s cap). Fallback poll keeps working. **Superseded 2026-07-26:** this originally keyed off imapflow's `AuthenticationFailure` class and then its `authenticationFailed` flag; both were wrong. See the 2026-07-26 connection-storm entry — only `serverResponseCode === "AUTHENTICATIONFAILED"` is permanent.
  - Consolidated 5 independently-defined `FakeEmailInbox` classes into `test/fakes/fake-email-inbox.ts`.
- **Verification** - 3 new `watchNewMail` tests (connects+opens+idles, debounced callback, stop logs out), 2 new poller tests (watcher fires processUnread, stop unwatches). All 106 tests pass, typecheck clean.

## 2026-07-24 - Consolidated test doubles for EmailInbox

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
