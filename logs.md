# Logs

## 2026-08-20 - Audit found two more state-loss traps; stage ops agent disabled; deploy dump persisted

- **Audit result** - Grep of `src/` for `env.[A-Z_]+_FILE` + the Dockerfile/compose volume map found **two more stores defaulting into the ephemeral container layer** on stage (wiped on every container recreate, same bug class as the anonymous `/data`): the **catch-up watermark store** (`WHATSAPP_CATCH_UP_STORE_FILE`, default `/root/secrets/message-automation-hub/whatsapp-catch-up.json` via `json-whatsapp-catch-up-store.ts:65`) and the **pending-group-invite store** (`PENDING_GROUP_INVITE_STORE_FILE`, `json-pending-group-invite-store.ts:65`). Verified the container runs as root (no `USER` in Dockerfile) with `MESSAGE_HUB_ENV_FILE` unset, so `homedir()=/root` holds. This explains the 14:02-03 catch-up-sweep miss: each stage deploy reset the per-chat watermark + baseline.
- **Fix** - `docker-compose.yml` now sets both to `/data/…` (inside the **named** `stage-data` volume added earlier today via `b257103`). Backlog gap: existing watermarks in prior ephemeral stores are unrecoverable, so a missed window may not replay; verify with a fresh forward + reply.
- **Stage memory: ops agent disabled** - `otelopscol` was ~60 MB RSS (last dump: `60320`), ~7% of the 964 MiB box, and nothing consumes its Cloud Logging/Monitoring output (deploy SA has no log-view perms; both stage and prod confirmed unmonitored via ops agent). deploy-stage now `systemctl stop/disable google-cloud-ops-agent` (+ the collector/fluent-bit sub-units), stage-only; deploy-prod untouched.
- **Deploy dump persisted** - the one-shot stats/RSS/logs dump is now also `tee`-d to `/opt/message-automation-hub/deploy-stats.log`, giving a per-deploy memory trend without a new cron job. Still no between-deploys snapshot; revisit if memory creeps.
- **Still open** - (a) watchdog: `/ready` endpoint on 8788 + Docker healthcheck covers *wedged/never-ready*, but a **synthetic end-to-end self-check** is the only thing that would catch the silent-reply-drop class — scheduled, not shipped; (b) IMAP watcher `Unexpected close` resilience; (c) catch-up 14:02-03 miss treated as explained by (a) above.

## 2026-08-20 - Stage email reply forwarded? No — thread store lives in an anonymous /data volume, reset every redeploy

- **Symptom** - After the memory diet (below), a new test WhatsApp forwarded to email fine (10:42-43), but the email reply to it (10:45-46) was never picked up: reply email stays **unread** in the inbox, no forward, and no `WA reply failed` failure notification.
- **Root cause** - Two compounding faults:
  1. **Anonymous `/data` volume** - `EMAIL_THREAD_STORE_FILE=/data/thread-store.json` and `IMAP_CHECKPOINT_FILE=/data/imap-checkpoint.json` live in `/data`, declared only as an anonymous volume by the `Dockerfile` (`VOLUME ["/app/.wwebjs_auth", "/data"]`, line 47). `docker-compose.yml` declares named volumes only for `whatsapp-session` and `./secrets`. Every `docker compose down`+`up` (every deploy) gives a fresh, empty `/data`; the orphaned anonymous volume is never reused. So the 11:35 container's thread-store is **empty** → the reply's In-Reply-To/References can't resolve the 10:42 test-message thread → `threadForEmail` returns null → `ReplyEmailToWhatsApp` bails at `reply-email-to-whatsapp.ts:47` → **no forward, no notification, email stays unread**. All three symptoms, exactly.
  2. **Flaky IMAP watcher on the live container** - The 07:38 container (which held the matching thread store and received the 10:42 test) logged `IMAP watcher error: Unexpected close` at 07:41:36, so it may never have fetched the 10:45 reply in the first place.
- **Fix (commit this entry, `stage-data` volume)** - `docker-compose.yml`: mount `stage-data:/data` (named) alongside `whatsapp-session`, and declare `stage-data:` in the volumes section. Thread store + IMAP checkpoint now survive redeploys the same way the WhatsApp session does. **Caveat** - the named volume is fresh on first boot after this change, so the pre-existing 10:45 reply's thread is unrecoverable regardless; verify with a *new* forward + reply.
- **Still open** - (a) IMAP watcher `Unexpected close` resilience; (b) catch-up sweep miss of the 14:02-03 message; (c) e2-small resize if ever needed.

## 2026-08-20 - Stage memory diet: Chromium + Node capped, WhatsApp reaches ready, forwarding works

- **Symptom** - Stage container booted (`WhatsApp Initializing client` + `Bot control server listening`) but never reached `Client is ready`; forwards dead; host showed `virtio_balloon: Out of puff! Can't get 1 pages` (guest at memory ceiling). Stage VM is a 1 GB e2-micro (964 MiB usable), persistently paging (475 MiB swap at idle from the deploy's `free -h`).
- **Diagnosis via deploy-dump stats** - Container used **424.7 MiB / 964.6 MiB (44%)** with 110 PIDs; top RSS showed ~700 MB across Chromium's many processes alone (`298M+102M+94M+78M+49M+38M` chrome). Node itself was small (single digits there); the hog was a full multi-process Chromium, not Docker. Low CPU-bursty `Out of puff` = intermittent host page grants → Chromium starves → no `ready`.
- **Fix (commit `c3c537d`)** - Collapse Chromium's process tree in `browserArgs()` (`--disable-features=SitePerProcess`, `--mute-audio`, `--js-flags=--max-old-space-size=256`) + cap Node's heap in `docker-compose.yml` (`NODE_OPTIONS=--max-old-space-size=256`). Result: container **291-307 MiB (30-32%)**, init CPU 346% (was 2585%), 99 PIDs.
- **Verification** - Post-fix deploy log showed `WhatsApp Client authenticated.` (07:42:10) + `Loading screen 100%` — first time stage's real client ever got past initialize; a fresh test WhatsApp forwarded to email end-to-end. **Catch-up sweep did NOT replay the pending 14:02-03 message** (watermark/baseline semantics — its chat's watermark may sit post-message or the sweep skipped it; open item).
- **CI workflow changes** - `deploy.yml` deploy-stage now waits 3 min then dumps `docker stats` + top-RSS + container logs **inside the same IAP-SSH session as the deploy** (`1dc894c`) — the earlier separate "Dump stage app logs" SSH step was flaky (exit 255), so the dump moved inline. `9e51d26` added the stats/RSS capture itself.
- **Still open** - (a) why catch-up missed the 14:02 message; (b) `IMAP watcher error: Unexpected close` (transient, auto-reconnects per 07-26 fix); (c) if 2 GB+ is ever wanted, resize stage to e2-small (~$10/mo) — memory diet first was the $0 attempt and it worked.

## 2026-08-19 - Stage WhatsApp forwarding dead (SingletonLock + disk-full); SSH deploys replace VM resets

- **Symptoms** - Stage (`message-hub-stage`) forwarded nothing: test WhatsApps TO the linked number (from another number) and FROM the email account produced no output. App otherwise booted (`Bot control server listening on 127.0.0.1:8788`, `Email automation polling is enabled`) but WhatsApp never initialized.
- **Root cause 1 - stale Chromium SingletonLock.** `docker logs message-automation-hub` (direct SSH pull, 10:18Z): `WhatsApp startup failed: Failed to launch the browser process: Code: 21` + "The profile appears to be in use by another Chromium process (20) on another computer (7307ff8e2066)". The old container's PID (`7307ff8e2066-20`) left `SingletonLock/SingletonSocket/SingletonCookie` symlinks in the **named volume** `message-automation-hub_whatsapp-session` (`/var/lib/docker/volumes/message-automation-hub_whatsapp-session/_data/session`), so every recreated container refused to launch Chromium. Fix: rm the three Singleton files + `docker restart`. Prod avoids this (deploy-prod startup script removes them); deploy-stage did not.
- **Root cause 2 - stage boot disk full.** Two deploys failed with `no space left on device` during layer extraction (`.../overlayfs/snapshots/.../node_modules/zod/...: no space left on device`; `tee: /var/log/message-hub-stage-deploy.log: No space left on device`). Every deploy pulls a fresh `stage-<sha>` image and old ones were never pruned on a small e2-micro boot disk. Fix: `docker image prune -af` before `docker compose pull` in deploy-stage.
- **Root cause 3 - app logs invisible on boot path.** Docker captures stdout; the serial console shows host logs only; ops-agent does not collect `logName:"container"` into Cloud Logging (config only ships syslog). VM's "Logs" tab is the serial console, not Cloud Logging. Fix: `logging: driver: journald` in `docker-compose.yml` (app stdout → systemd journal → serial console) — committed `a5aa1cd`; **note** app logs almost nothing on success (only lifecycle/error lines), a clean forward produces no line.
- **Deploy refactor - SSH instead of VM reset.** deploy-stage previously wrote a startup-script to metadata + `gcloud compute instances reset` + serial-poll for a marker (up to 1h) — chosen in `539bbb4` to avoid SSH/OS-Login/key setup (documented in `docs/github-actions-iap-deploy.md`). Replaced (`0e205b7`) with `gcloud compute ssh --tunnel-through-iap` running the deploy live (compose files ship as base64 env vars; startup-script metadata still updated so a future reboot re-runs `docker compose up -d`). **Verified working from GH Actions** — the WIF runner's SA pushes its own ephemeral key; no IAM changes were needed. Deploy time drops from ~15-25 min (reboot + 6m+ userspace boot) to ~2-3 min with no VM downtime.
- **Process lesson (fed into AGENTS.md)** - I reverted the SSH refactor believing the SA lacked IAP/OS-Login roles without ever running `gh run view --log-failed` on the failing run. The log proved SSH logged in fine; the failure was disk-full — the same disk-full the prune fixes. Rule added: before any revert/rollback/"won't work" claim, pull the actual failure log.
- **Verification** - Deploy run `32251930597` (prune + reset path) succeeded; container started with `a64b203`. Deploy run `32257179936` (SSH path) succeeded: `WhatsApp Initializing client` + `Bot control server listening` with no `Code: 21`/`startup failed`. Stage VM has 1GB swapfile + swappiness 10 (from earlier deploy) for the e2-micro memory pressure.
- **Still open** - confirm a real forward end-to-end (send test WhatsApp → check inbox); Cloud Logging dump step in deploy-stage returns PERMISSION_DENIED for the SA (`no log views`), so log visibility still relies on SSH dump — fine now that SSH works.

## 2026-08-17 - Prod stuck-window (OPENING) ate a command email + missed WhatsApp messages

- **Incident** (master `message-hub-2`, journal): the WhatsApp Web page went `State changed: OPENING` at 10:38 UTC and stayed wedged until a manual `systemctl restart` at 15:46 UTC. During the window nothing was received; afterwards the re-sync replayed only *some* pending messages (Ori's text arrived 40 min late; a link/video message was never replayed).
- **Lost command email** - `wa:` email 401 was `markProcessed` (forward-email-to-whatsapp.ts) then wedged in `ensureChatForPhoneNumber` → `pupPage.evaluate` outside any timeout → permanently lost. This is THE bug: a hung page makes the send hang forever with no log.
- **Catch-up sweep failed** - 7s after `ready`, `getChats()` (puppeteer evaluate) threw `r: r`; the sweep aborted once and never retried (`runCatchUpIfPending` only runs on `ready`, no backoff). Messages inside the stuck window beyond the re-sync replay were therefore never recovered.
- **Fix (committed on master `6caa0d4` AND stage `9d572ab`)** - `sendMessage`/`sendImage` now wrap `ensureChatForPhoneNumber` in the existing `sendWithContext` (90s `withTimeout` + clear error), so a hung page becomes a logged+notified failure that surfaces in `markFailedAndNotify` instead of an eternal wedge. New adapter test: hung `pupPage.evaluate` → `Chat lookup for <phone> failed` after `sendTimeoutMs`. 25 (master) / 26 (stage) channel tests pass, typecheck clean.
- **Still open** - ~~(a) catch-up sweep needs a retry/backoff when `getChats()` fails right after `ready` ("r: r" case); (b) unknown chats sweep from the `initialized` baseline, not the newest watermark, or any first-contact message during an offline/stuck window is unrecoverable.~~ **Implemented same day** - `CatchUpState.baseline` (Unix s of the first-ever sweep) is recorded at init and preserved through save/load; unknown chats now sweep from `state.baseline` (falling back to the oldest watermark on pre-baseline stores). `getChats()` is wrapped in a 3-attempt/5s retry (`getChatsWithRetry`) so the "r: r" right-after-`ready` case no longer kills the whole sweep. New tests: store baseline round-trip + adapter retry-once test. 166 tests pass, typecheck clean. Also added the prod-equivalent **1GB swapfile + swappiness 10** block to the `deploy-stage` startup script in `.github/workflows/deploy.yml` (stage had none; prod's `deploy-prod` already did).
- **Staging VM `message-hub-stage` is under memory pressure** - repeated `systemd-journald: Under memory pressure, flushing caches.` and `virtio_balloon: Out of puff! Can't get 1 pages` (guest could not be granted more ballooned pages = at memory ceiling). Likely why the staging container never reliably picks up WhatsApp (Chromium OOM-starved). Confirm `free -h`/`docker stats` when IAP/gcloud access returns (gcloud blocked 2026-08-17 evening by NetFree CA: expired `NetFree Sign, 019` leaf breaks Python cert verify, `_ssl.c:1081`).
- **Evidence breadcrumb** - catch-up store `/home/opc/secrets/message-automation-hub/whatsapp-catch-up.json` (watermarks per `@lid` chat); master env at `/etc/message-automation-hub/control.env` + `~/secrets/message-automation-hub/.env`; ready email `Sent ready notification email` 15:50:24 UTC.

## 2026-08-16 - Merge master into stage; unify the PluginContext definitions

- **Goal** - Make stage a superset of master (catch-up sweep, unlinked fail-fast) while landing the Obsidian-style external plugin model on top of one typed plugin runtime.
- **Merge** - `git merge master` into `stage`. Conflicts: `whatsapp-web-channel.ts` (group-invite vs catch-up), `providers.ts` (capabilities const location + catch-up wiring), `index.ts` (dropped plugins vs `process.env` arg), `logs.md`. `master` had never touched `plugin-runtime.ts` since merge base `9d28089`, so the merge silently kept stage's *untyped* `PluginContext` with no conflict markers — the trap the work order flagged. Manual steps 1-4 were required, not conflict resolution.
- **Unified runtime** - `PluginContext`/`HubPlugin` now live in `src/core/plugin-runtime.ts`: typed `provide`/`require`/`has` against `Capabilities` (master's `id`/`requires?`/`register` plugin shape with pre-registration dependency validation) plus typed `on`/`emit`/`hasListeners` against `EventMap` (stage's event system). `api/index.ts` re-exports from `plugin-runtime.ts` instead of defining its own copies (dropped the reverse import to avoid circularity). The untyped `require<T>()` calls (15 sites across `src/index.ts`, `providers.ts`, `whatsapp-email-bridge.ts`) now infer from the capability key; dead type imports removed.
- **Config & utilities** - Dropped `config`, `formatError`, `parseSubjectCommand` from `PluginContext` (zero `src/` callers). `config` plumbing (`pluginConfig` param, `contextOrConfig` union, `isPluginContext`) died in the rewrite. `parseSubjectCommand` and the stack-bearing `formatError` are re-exported as plain functions from `api/index.ts`.
- **Barrel** - Trimmed internal infrastructure exports (`EmailInbox`, `InboundChannel`, `WhatsAppPairing`, stores, handler interfaces) so external plugins can't reach them; added `Capabilities`/`CapabilityName`/`EventMap`/`EventName`/`EventHandler`/`DeliveryStatus`/`WhatsAppGroupInviteV4`; tightened `satisfies Record<string, CapabilityName>` on the `capabilities` const.
- **Verification** - 163 tests pass, `tsc --noEmit` clean, `tsc -p tsconfig.build.json` clean. New `test/external-plugin-smoke/example-plugin.ts` (compiled by typecheck, skipped by vitest) imports `@message-automation/core` via the package's own `exports` map (Node/TS self-referencing — no symlink, no `npm link`, works on fresh clone/CI), augments `Capabilities`, and exercises `id`/`requires`/`register` + typed require/on.
- **Committed on `stage`** - 5 commits: merge+type atomic, barrel trim, util re-exports, dedupe+temp-file fixes, smoke fixture.

## 2026-08-14 - Fail-fast sends while WhatsApp is unlinked, with one-time re-link alert

- **Problem** - After the session is revoked (`LOGOUT`), sends attempted while the bot is still "Waiting to be linked" dive into the WhatsApp Web page drone with no `WWebJS`, failing as the cryptic `Cannot read properties of undefined (reading 'getChat')` (the 08-12 Defect 3, again 08-13 for reply emails 385/387). Because `ReplyEmailToWhatsApp` skips `markProcessed` on failure, the emails are **not lost** — they retry each poll and flush once the device re-pairs — but the churn was silent unless `failureNotification` was set.
- **Fix** - `WhatsAppWebChannel` now tracks `linked` (false until first `ready`, false again on `disconnected`). `sendMessage`/`sendChatMessage`/`sendImage` fail fast *before* touching the page: `ensureLinked()` throws `"WhatsApp is not linked yet; request a pairing code"` and fires the existing `errorNotification` **once per unlinked window** (`unlinkedNotified`, reset on the next `ready`).
- **Verification** - 3 new tests (clear error + no send while unlinked; sends work after `ready`; single re-link alert per window, repeated after a fresh link). 168 tests pass, `tsc --noEmit` clean.
- **Ops** - This is symptom management; the session revoke itself is WhatsApp kicking the unofficial web client (see 08-12 entry). Re-link = request a pairing code from the bot control server.

## 2026-08-14 - WhatsApp catch-up: forward messages missed during an offline window

- **Problem** - A crash or logout (Reversed the bot) leaves a gap: messages received while the client was down are never forwarded to email. The old code shipped history only via `window.WWebJS onAnyMessage` re-sync, which re-emits everything but was unused for forwarding.
- **Change** - `WhatsAppWebChannel` now runs a catch-up sweep after the first `ready` and after every `disconnected`+`ready` cycle:
  - `runCatchUpIfPending` / `sweepForMissedMessages`: on `ready`, `getChats()` and fetch the newest messages per chat, forwarding any not-from-me message newer than the persisted watermark. Skips pre-existing history on first ever run (`initialized` baseline) so we never flood email with the account's old backlog.
  - `trackWatermark` advances the stored per-chat timestamp as live messages are handled, so the sweep finds nothing new during a normal session (idempotent against the 8× `ready` re-sync storm from 08-12).
  - New `JsonWhatsAppCatchUpStore` (atomic write, serialized save queue) persists chat watermarks in `whatsapp-catch-up.json` next to the env file; `WHATSAPP_CATCH_UP_STORE_FILE` overrides. Wired via `createWhatsAppWebPlugin(config, process.env)`.
- **Verification** - 5 new store tests. 165 tests pass, `tsc --noEmit` clean. No adapter-level sweep test: the sweep runs only against a real WhatsApp Web load (no fake yet); the module-imports and bundled-plugins suites cover wiring.
- **Note** - `chatLimit`/`messageLimitPerChat` config supported but not yet in env/config plumbing; defaults 50/50. Add when the default sweep is too slow.

## 2026-08-12 - WhatsApp session revoked (LOGOUT): ready-email storm, crash, then systemd restart

- **Symptoms** (prod `message-hub-2`, journal 2026-08-12): 8× `authenticated` + 8× `ready` + 8× ready-notification emails at 04:20:44-51; `disconnected: LOGOUT` at 04:21:06; crash at 04:21:45 with `Failed to add page binding with name onQRChangedEvent: window['onQRChangedEvent'] already exists!`; systemd restart at 04:22:48. Evening: one WhatsApp send failed with `Cannot read properties of undefined (reading 'getChat')` (caught, logged, no crash).
- **Root cause - WhatsApp revoked the session.** The 8× sync storm + LOGOUT is the signature of server-side session invalidation (device kicked), not a user action. The user did nothing; likely WhatsApp invalidating the unofficial web client after the July 2026 web update (the same update that renamed `id._serialized` → `id.$1`, see 07-24 entry). Cannot be fixed in code; re-link with a pairing code after restart.
- **Defect 1: ready-email storm.** whatsapp-web.js re-emits `authenticated` AND `ready` on every socket `hasSynced`; `sendReadyNotification` fired once per `ready` → 8 emails in ~2s. Fix: guard `readyNotificationSent` (set *before* the SMTP await so concurrent `ready` events can't both pass).
- **Defect 2: crash on logout.** The library re-runs `inject()` on every `framenavigated`; after logout, two concurrent `inject()` calls race in `exposeFunctionIfAbsent('onQRChangedEvent')` (check-then-act) → puppeteer throws `window['onQRChangedEvent'] already exists!` → unhandled rejection → node exits. Fix: on `disconnected`, log a clear "re-link" message and `process.exit(1)` immediately, so systemd starts a clean client before the 39s post-logout race can fire.
- **Defect 3 (transient): `reading 'getChat'` on undefined.** `window.WWebJS` is undefined in the page between a navigation and the library's re-inject; a send landing in that gap throws. Handled (no crash), but email 383 was not delivered. Not fixed here; note the `@lid` target chat id.
- **Verification** - 2 new adapter tests (ready email once despite repeated `ready`; process exits on `disconnected`). 153 tests pass, `tsc --noEmit` clean.

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
