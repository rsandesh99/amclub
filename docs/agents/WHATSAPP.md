# WHATSAPP.md — WhatsApp rails (S0.5)

WhatsApp is the channel MSMEs actually read (DESIGN.md §2.2). S0.5 lands the
**rails** — adapter, templates, webhook, conversation store, opt-in — with no
agent behind them yet. Everything is inert until the founder provisions a
vendor: the driver is `stub` (logs, never bills), outbound replies from the
inbound job are gated on the runtime's `AGENT_ENABLED`, and the web opt-in
section is gated on the web `AGENT_ENABLED`.

## Topology

```
 user's WhatsApp ──► vendor (Meta Cloud API | Interakt) ──► POST https://<runtime>/webhooks/whatsapp
                                                              │ verify signature → wa_conversations/wa_messages
                                                              │ (store only; 5xx on a store failure → the vendor retries)
                                                              └► pg-boss `wa.inbound` (job id = message id)
                                                                   │ re-derive the owner from users.phone (M41)
                                                                   │ media → private bucket `wa-media` (capped; opted-in numbers only, M34)
                                                                   └► the dispatcher → processed_at (the minute sweep re-drives the rest, M33)
 web dispatcher (createNotification … channels:['whatsapp']) ──► agent-core sendTemplate (approved templates only)
```

- **Adapter**: `packages/agent-core/src/whatsapp` — `WhatsAppProvider` interface;
  drivers `meta_cloud`, `interakt`, `stub`; picked by `WHATSAPP_DRIVER` **and**
  the driver's credentials (missing creds ⇒ stub).
- **The webhook only accepts signed requests.** With the stub (no live driver)
  `POST /webhooks/whatsapp` answers 401 `webhook_not_configured`, because the stub
  cannot check a signature and anyone could otherwise post a message "from" any
  registered number (audit H4). For local testing only, set
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=true` with `NODE_ENV` other than `production`.
- **Templates**: `templates.ts` — one entry per notification kind, per-locale
  approved names, param builders. An unregistered kind can never reach the vendor.
- **Opt-in policy**: order/payment events to a party of the order
  (`WA_ALWAYS_ALLOWED_KINDS`) send without a grant (transactional under BSP
  policy). Every other kind needs an active `agent_grants` row with
  `channel='whatsapp'` — created when the user sends **START** from their
  registered number, revoked on **STOP** or from Settings.

## Setup — Meta Cloud API (`WHATSAPP_DRIVER=meta_cloud`)

1. Meta Business → WhatsApp → create the app, add a phone number, generate a
   **system-user token** (permanent). Note the **Phone number ID** and the app's
   **App Secret**.
2. Runtime secrets (Fly): `WHATSAPP_DRIVER=meta_cloud`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (any
   random string), `AGENT_ENABLED=true` (to let the job reply), `WA_MEDIA_BUCKET`
   (default `wa-media`; create with `pnpm --filter @amclub/db db:setup-storage`).
3. Web env (Vercel): the same `WHATSAPP_*` (for outbound templates) +
   `NEXT_PUBLIC_WHATSAPP_NUMBER=<E.164 digits>` for the wa.me link.
4. Webhook: callback URL `https://<runtime>/webhooks/whatsapp`, verify token =
   `WHATSAPP_VERIFY_TOKEN`; subscribe to `messages`. Meta signs POSTs with
   `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret) —
   the runtime rejects anything else with 401.
5. Submit the templates in `docs/PRE_LAUNCH_CHECKLIST.md` 1.3 for approval
   (utility category, en + hi). Names must match exactly.

## Setup — Interakt (`WHATSAPP_DRIVER=interakt`)

1. Interakt dashboard → API key (Basic). Set `INTERAKT_API_KEY`.
2. Webhooks → set the URL to `https://<runtime>/webhooks/whatsapp` and add a
   custom header `x-interakt-secret: <INTERAKT_WEBHOOK_SECRET>` — Interakt has
   no HMAC, so this shared secret is the auth; the runtime rejects a mismatch.
3. Templates: same names, submitted through Interakt's template UI.

## Testing with the Meta test number

- Send **START** from a phone whose number is on the account (`users.phone`,
  stored `+91…`). Expect: `wa_conversations` row bound to the user, a
  `wa_messages` row (`direction=in`), an `agent_grants` row
  (`channel=whatsapp`, `channel_identity=+91…`, scopes `[]`), and the
  `amc_wa_opt_in_*` template back (only if `AGENT_ENABLED=true` on the runtime).
- Send **STOP** → grant revoked + `amc_wa_opt_out_*`.
- Send anything else → `amc_wa_holding_*` at most once per 24h.
- Replay the same webhook body → no new rows (`vendor_message_id` unique).
- Offline proof any time: `pnpm --filter @amclub/web whatsapp:verify`.

## Rollback

`WHATSAPP_DRIVER=stub` (or remove the credentials) on web + runtime: outbound
becomes a logged stub instantly, and the webhook refuses every inbound POST
(401), so nothing is ingested. Scale the runtime to 0 to stop it entirely.

## Privacy

Only vendor ids, phone (E.164), text, and media object paths are stored; media
sits in a **private** bucket and is read via signed URLs. Nothing here is
exposed to a client role (no RLS policies except admin/ops read).

## S1.6 — the onboarding interview

**Dispatcher order** (`apps/agent-runtime/src/whatsapp/inbound.ts`): STOP
(opt-out always wins) → **active session** (`wa_conversations.active_session_id` routes
every other message into the interview, one `agent.onboarding` job per
message) → **JOIN** (`ONBOARDING_KEYWORDS`: with a grant and
`agents_enabled.onboarding` + cohort it attaches the user's web-started session
or creates one and enqueues `start`; without a grant JOIN keeps its S0.5 opt-in
meaning, so the dark behaviour is unchanged) → holding reply. JOIN/जुड़ें/చేరండి
moved out of `WA_OPT_IN_KEYWORDS`; START/YES/HI/… are unchanged.

**Interactive buttons.** `WhatsAppProvider.sendButtons(to, text, buttons,
listLabel?)`: Meta sends ≤ 3 as reply buttons and 4..10 as a list (single
pick); the tap comes back as `kind='button'` with `buttonPayload` = the id
(`button_reply` and `list_reply` both parsed). Interakt has no interactive
payload wired: options go out as numbered lines and the machine accepts the
number; the draft confirmation (`confirm:<runId>`) therefore needs Meta
(FOLLOWUPS S1.6). The stub logs.

**Templates** (opt-in gated, en/hi/te): `onboarding_start`,
`onboarding_resume`, `onboarding_draft_ready`, `onboarding_expired` — see
`docs/agents/ONBOARDING.md` and PRE_LAUNCH_CHECKLIST 1.3.

**Media retention.** Voice notes and workshop photos stay as objects in the
private `wa-media` bucket at `<conversationId>/<vendorMessageId>.<ext>` (fetched by
the `wa.inbound` job, capped, opted-in numbers only — see "Audit wave 5");
`onboarding_sessions.photo_refs` holds the paths; reads are 15-minute signed
URLs (wizard, partner dashboard, admin). Nothing is copied into the provider
media pipeline in this stage.

## S2.3 — the Support agent

**Dispatcher order** now: STOP → active onboarding session → Munshi (S2.2) → opt-in
keywords → JOIN → **support** → holding reply. The support branch takes a text /
audio message from a user with an active WhatsApp grant when `AGENT_ENABLED` (runtime)
and `agents_enabled.support` + cohort are on, and a `nudge:yes|no:<runId>` button whose
run is the user's. **A button tap is classified by its payload id, never its title:** the offer's "No" / "नहीं" (payload
`nudge:no:<runId>`) is not the S0.5 opt-out keyword; a template quick-reply whose payload is STOP still opts out. An open ticket (`wa_conversations.support_ticket_id`) stores the
message and replies **nothing** until a human resolves it at `/admin/support`. Anything
else still gets the S0.5 holding reply (≤ 1 per 24 h). The run's token persona is the
grant's persona (`buyer` for an msme user, else `provider`).

**Templates** (en/hi/te; opt-in gated except the two transactional nudges):
`support_reply` (`amc_support_reply_*`, params `[title, body]`, the out-of-window
carrier for any support reply), `support_escalated` (`[ticket ref]`),
`support_ticket_opened` (ops, `[summary]`), `support_resolved` (`[note]`),
`order_nudge` / `rfq_nudge` (`[body]`). The nudge confirmation is in-window
buttons only. Add them to the approval batch in PRE_LAUNCH_CHECKLIST 1.3; runbook
`docs/agents/SUPPORT.md`.

## S2.4 — the Munshi growth nudge

Weekly (`munshi.growth`), at most one line per Munshi provider: template `munshi_growth`
(`amc_munshi_growth_{en,hi,te}`, params `[nudge line]`; opt-in gated) outside the window, plain text inside it —
only while the provider holds the WhatsApp grant (STOP halts it; the in-app copy still arrives). Fixed copy, no
model. Runbook `docs/agents/SCORE.md`.

## S3.1 — the Buyer Procurement Agent

**Dispatcher order** now: STOP → active onboarding session → Munshi (S2.2) → **procurement (S3.1)** → opt-in
keywords → JOIN → support (S2.3) → holding reply. Procurement sits with Munshi, BEFORE the opt-in keywords, because
"yes" / "ok" / "hi" are opt-in words: after them a buyer's typed yes to a draft would never reach the session. It
takes a `pr:` button of this buyer (`pr:ok|edit|no:<runId>`, `pr:label:<session>:<A-G>`, `pr:sess:new|cur:<messageId>`
— the `pr:` namespace keeps them apart from Munshi's `edit:` and Support's `nudge:`) or any message while
`wa_conversations.procurement_session_id` points at an active session. With no session, Support's `new_need`
(`support_intent@v2`) offers "Shall I start a request for this?" with one `pr:sess:new` button. STOP still wins, and a
typed "no" / "cancel" / "नहीं" is the S0.5 opt-out — the agent's cards use buttons. `grantWhatsApp` now keeps the
scopes of the grant it refreshes (a re-sent "hi" used to re-insert `[]`, silently dropping Munshi / procurement
scopes).

**Template** `procurement_update` (`amc_procurement_update_{en,hi,te}`, params `[one line, the assistant link]`; opt-in
gated) carries any procurement message outside the 24 h window; the buttons are in-window only, so decisions then
happen in the app. Runbook `docs/agents/PROCUREMENT.md`.

## Audit wave 5 — reliability and identity (M33, M34, M41, M42; migration 0079)

**Stored means processed (M33).** The webhook stores the message and answers 200; a store failure answers 500
so the vendor retries (a replay of a stored message is a no-op, and re-enqueues it when it was never processed).
The `wa.inbound` job's id IS the message id, so a message has at most one job while pg-boss keeps it (≥ 12 h).
The job stamps `wa_messages.processed_at` when the dispatcher finished (0079; the webhook inserts NULL, every
other writer gets `now()` by default). The runtime schedules `wa.inbound.sweep` every minute: inbound rows still
unprocessed after a minute and younger than 6 h get a job when they have none (their first enqueue failed or the
worker was down); older ones are counted as `stale`. The runtime exits when the worker cannot start (Fly
restarts it) and `/health` reports `worker` (state, DATABASE_URL, the last sweep) and answers 503 while agents are
on and the worker is not running. Before 0079 is applied the webhook stores without the column (logged once) and
the sweep reports `sweep_read_failed`.

**Media is fetched by the job, capped (M34).** The webhook never downloads: it keeps the vendor media id in the
payload (`amc_media_ref`). The job downloads only for a number bound to a user who holds a WhatsApp grant given
FROM that number; an unknown or non-opted-in number's media is never fetched (`payload.amc_media_status =
skipped_not_opted_in`). Every download goes through the driver's limits (agent-core `whatsapp/media.ts`): a
timeout on each fetch (`WA_MEDIA_TIMEOUT_MS`, default 20 s), a MIME allow-list checked before a byte is read
(JPEG / PNG / WebP, OGG / Opus / MP3 / MP4 / AAC / AMR audio, PDF), Graph's declared `file_size`, then
Content-Length, then a streamed byte cap (`WA_MEDIA_MAX_BYTES`, default 10 MB). Interakt media URLs must be
https on a public host. A refusal is recorded (`refused:<code>`) and the message is still handled without media.

**A conversation is a phone, not an account (M41).** Every inbound message re-derives the owner
(`whatsapp/binding.ts`): when the bound user's `users.phone` is no longer this number, the conversation is
unbound (`user_id`, `active_session_id`, `procurement_session_id`, `support_ticket_id` → null), the WhatsApp
grants given from this number are revoked, the Munshi drafts delivered here are expired (their runs cancelled)
and the procurement sessions delivering here fail (`phone_changed`); then the number's current holder is bound.
Migration 0079's trigger `users_phone_change_wa_unbind` does the same unbind + revoke the moment `users.phone`
changes. Every WhatsApp grant lookup requires `channel_identity = '+' || phone_e164` (the inbound grant checks,
Munshi's `enabledProviders` / `providerStateFor`, procurement's `buyerGrant`, support's persona, onboarding, the
web notification dispatcher), and every outbound picks the conversation of the user's CURRENT phone
(`boundConversationFor`) — never "the most recent inbound". STOP still revokes every WhatsApp grant of the
(re-derived) owner.

**A typed yes confirms at most one proposal (M42).** Buttons carry their run id and are routed first. Free text
(text / audio / image / document) goes through `whatsapp/confirmations.ts`, which collects the user's open
confirmable proposals on this conversation — Munshi drafts whose card went out here, the procurement session's
open proposal, a support nudge offer — and binds with agent-core `bindTextConfirmation`:

- a reply that QUOTES one of our cards (Meta `context.id` → our outbound row → its `run_id`) binds to exactly that
  card; a quote of anything else binds to nothing;
- otherwise exactly one open proposal, inside its agent's text window (Munshi: 30 min after its latest card;
  its buttons stay valid for the 24 h draft TTL), binds to it;
- anything else is ambiguous: the open cards are re-sent (`munshi.decide` action `reask`; procurement's own card)
  and NOTHING is approved. The agents enforce it too: `munshi.decide` reads text only with `textApproval: true`,
  and a WhatsApp procurement turn turns an approving yes into a card re-send unless `textApproval: true`.

**Dispatcher order** now: re-derive the owner → STOP → media → active onboarding session → Munshi buttons →
procurement `pr:` buttons → **free text vs the open proposals** (above) → opt-in keywords → JOIN → support →
holding reply. An active procurement session still takes the buyer's messages (with text approval off unless the
binding pointed at it).

## S1.4 note — founder one-tap

The Payout-Evidence agent notifies the ops user by kind `payout_dossier_ready`
(template `amc_payout_dossier_ready_{en,hi}`, opt-in gated: the founder must
have an active WhatsApp grant from their own START). The message deep-links to
`/admin/payouts?dossier=<id>`; Approve/Hold are taps on the web panel, never
in-chat replies. Add the template to the approval batch in PRE_LAUNCH_CHECKLIST 1.3.
