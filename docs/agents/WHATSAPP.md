# WHATSAPP.md — WhatsApp on Meta's Cloud API (S0.5 rails, ADR-030)

WhatsApp is the channel MSMEs actually read (DESIGN.md §2.2). AMClub talks to **Meta's Cloud API directly** with its
own number — no Business Solution Provider (ADR-030 §1; the Interakt driver is removed). Everything is inert until the
founder provisions the number: the driver is `stub` (logs, never bills), outbound replies from the inbound job are
gated on the runtime's `AGENT_ENABLED`, and nothing is sent to a phone without the consent ADR-030 §2 requires.

## Topology

```
 user's WhatsApp ──► Meta Cloud API ──► POST https://<runtime>/webhooks/whatsapp      (apps/agent-runtime, Fly bom)
                                          │ verify X-Hub-Signature-256; drop another phone number id / WABA
                                          │ messages → wa_conversations / wa_messages (text stored REDACTED)
                                          │ statuses → the outbound row (status, error, pricing, cost)
                                          │ account fields → wa_account_events (+ the wa_templates mirror)
                                          │ (store only; 5xx on a store failure → Meta retries)
                                          └► pg-boss `wa.inbound` (job id = message id)
                                               │ stale (> 24 h)? → processed, amc_stale, never answered
                                               │ re-derive the owner from users.phone (M41)
                                               │ media → private bucket `wa-media` (capped; opted-in numbers only, M34)
                                               └► the dispatcher → processed_at (the minute sweep re-drives the rest, M33)

 every outbound (web notification dispatcher, dispatcher replies, Munshi, Support, procurement, onboarding)
   └► agent-core sendWhatsApp()  ── consent + suppression → window → ledger row (queued, idempotency key)
                                     → driver call (timeout) → classified error → outcome on the row
```

- **Adapter**: `packages/agent-core/src/whatsapp` — `WhatsAppProvider` with two drivers, `meta_cloud` and `stub`,
  picked by `WHATSAPP_DRIVER=meta_cloud` **and** its phone number id + token. A named driver with a missing credential
  is never silently trusted: `whatsappDriverState()` reports it (names only, never values), the runtime logs an error
  at boot, `/health` shows `whatsapp.missing` and `degraded: whatsapp_misconfigured`, and the webhook answers 503
  `whatsapp_not_configured` until it is fixed.
- **The webhook only accepts signed requests.** With the stub `POST /webhooks/whatsapp` answers 401
  `webhook_not_configured` (the stub cannot check a signature; audit H4). For local testing only, set
  `WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=true` with `NODE_ENV` other than `production`.
- **Templates**: `templates.ts` (+ `templates-notify.ts`, `templates-system.ts`) — one `WaTemplateSpec` per kind: the
  Meta name stem, category (`utility`), the body exactly as submitted in en / hi / te / ta, typed parameters and an
  optional URL button (`https://amclub.in/{{1}}`, suffix = the screen). `resolveTemplate(kind, locale)` returns a
  (name, language) pair that exists: the locale's variant when it was submitted, else the en name **with** the en
  code (audit B2). An unregistered kind can never reach Meta. The approval list is generated:
  `pnpm --filter @amclub/agent-core templates:list` (PRE_LAUNCH_CHECKLIST 1.3).

## Consent (ADR-030 §2)

Consent belongs to a **phone** and a **purpose** — `transactional` (orders, requests, payments), `assistant` (the
assistant writing first), `marketing` (never without its own opt-in). `wa_phone_consents` holds the state,
`wa_consent_events` the append-only proof; both are written only by `record_wa_consent()`. The send path's rule
(`mayMessage`):

- **business-initiated** (we write first, or a reply after the window closed): the purpose must be `opted_in`;
- **a reply inside the 24-hour window**: only "not STOPped" (transactional **and** assistant opted out);
- **after STOP nothing goes** except the one opt-out confirmation (`wa_opt_out_confirmed`, once per STOP);
- **suppression** (`wa_suppressions`, until null or future) blocks every purpose, except `marketing_stopped`, which
  blocks marketing only. 131026 (not on WhatsApp) suppresses for 30 days, 131050 (stopped marketing) for 90; an
  inbound message from the number lifts a not_on_whatsapp suppression.
- `WA_ALWAYS_ALLOWED_KINDS` is gone (kept as an empty, deprecated export): no kind sends without consent.
- Consent is separate from agent delegation (`agent_grants`).
- **Before migration 0086** (no consent tables yet) the send path falls back to the pre-ADR-030 rule — replies pass,
  order / payment kinds pass, anything else needs an active WhatsApp grant from that phone — and logs it once.

## The one send path and the ledger (ADR-030 §3)

`sendWhatsApp(deps, req)` (agent-core) is the only caller of a driver's send methods. The runtime wraps it in
`apps/agent-runtime/src/whatsapp/outbound.ts` (`runtimeSend`, `sendSystem`); the web notification dispatcher calls it
directly. In order:

1. refuse a bad phone (a business-scoped id is never reduced to digits);
2. the conversation of the phone (created when the phone has none) carries the window;
3. consent + suppression (above); a `reply` after the window is treated as `business`;
4. free-form (text, buttons, `cta_url`, media) only while `window_open_until − wa_window_margin_seconds` (default
   120 s) is in the future; otherwise `fallbackTemplate` (or `skipped: outside_window`); a template goes anywhere; a
   template Meta paused, disabled, rejected or re-categorised (the `wa_templates` mirror) is refused;
5. the outbound `wa_messages` row is written **before** the call (status `queued`, `idempotency_key` unique, user,
   notification kind / id, run id, template name + language + category, payload incl. the caller's `meta`). The same
   key again is `duplicate`; a failed-but-retryable attempt is re-sent on the same row (claimed by compare-and-set,
   at most 5 attempts);
6. the driver call (timeout `WHATSAPP_TIMEOUT_MS`, default 10 s) and the parsed Graph error, classified:
   131047 (outside the window) → retried once as the fallback template; 131026 / 131050 → suppression; 131049
   (marketing limit) → failed, no suppression; 130429 / 131056 / 5xx / network → retryable; 368 / 131031 / 190 → not
   retryable **and** a 10-minute circuit breaker (every send fails fast with `account_restricted`; `/health` shows
   `whatsapp.circuitOpenUntil`);
7. the outcome on the row (`vendor_message_id`, `sent` / `stub` / `failed`, `error_code`, `error_title`, `status_at`),
   `last_outbound_at` on success.

Runtime conventions: agent messages use purpose `assistant`; `initiation: 'reply'` when answering the user's own
message (Support, a Munshi / procurement decision, onboarding turns), `'business'` when the runtime writes first
(Munshi cards and warnings, the growth note, the procurement chase, onboarding expiry). Idempotency keys come from
the inbound message id, the run id or the recorded agent turn (`pt:<turn id>`), so a retried job never sends twice.
A card's run id rides in the row's payload (M42: a quoted reply binds to exactly that card); a template fallback that
carries no card can drop it (`fallbackMeta`).

**Delivery statuses and cost.** The webhook writes the status (never backwards: the 0086 trigger), its time, the
error code / title of a failure, and Meta's pricing object: `billable`, `pricing_category` and `cost_millipaise`
(integers — 1/1000 paise) from `agent_settings.wa_rate_millipaise` (default utility / authentication / service
11 500, marketing 86 310 — ₹0.115 / ₹0.8631 per message, excl. 18 % GST). Non-billable messages (the free service tier,
free entry points) cost 0. A status write that fails answers 500 so Meta retries.

**Account webhooks.** Every non-message field is stored as received in `wa_account_events`;
`message_template_status_update`, `template_category_update` and `message_template_quality_update` also update the
`wa_templates` mirror (status, category, rejection reason, quality) that the send path checks.

**Identity (audit 2.9).** A message that carries only a business-scoped user id (BSUID) is stored under a
conversation keyed `u:<bsuid>` — never digits, never bound to a user (binding needs a phone) — unless a conversation
already holds that BSUID; a phone conversation records the BSUID when Meta sends one.

**Stale inbound.** A message whose Meta timestamp is more than 24 h old when the job runs is marked processed with
`payload.amc_stale = true` and never answered.

## Setup — Meta Cloud API (`WHATSAPP_DRIVER=meta_cloud`)

1. **Account (D-WA4).** Meta Business → WhatsApp: create the WhatsApp Business Account **in INR** — the currency
   cannot be changed later, and non-INR accounts of Indian portfolios reportedly stop delivering after 31 Dec 2026.
   Complete business verification, add the dedicated number, generate a **system-user token** (permanent). Note the
   **Phone number ID**, the **WhatsApp Business Account ID** and the app's **App Secret**.
2. **Runtime secrets (Fly):** `WHATSAPP_DRIVER=meta_cloud`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`,
   `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (any random string), `WHATSAPP_WABA_ID`, optionally
   `WHATSAPP_GRAPH_VERSION` (format `vNN.0`, default `v24.0`; an invalid value falls back and `/health` lists it under
   `whatsapp.invalid`) and `WHATSAPP_TIMEOUT_MS` (1000–60000, default 10000); `AGENT_ENABLED=true` (to let the job
   reply), `WA_MEDIA_BUCKET` (default `wa-media`; create with `pnpm --filter @amclub/db db:setup-storage`).
3. **Web env (Vercel):** the same `WHATSAPP_*` (validated in `apps/web/lib/env.ts`) for outbound notifications +
   `NEXT_PUBLIC_WHATSAPP_NUMBER=<E.164 digits>` for the wa.me link.
4. **Webhook:** callback URL `https://<runtime>/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`. Subscribe
   to `messages`, `message_template_status_update`, `template_category_update`, `message_template_quality_update`,
   `phone_number_quality_update`, `account_update`, `account_alerts`. Meta signs POSTs with `X-Hub-Signature-256`
   (HMAC-SHA256 of the raw body with the app secret); the runtime rejects anything else with 401 and drops entries
   for another phone number id or WABA (a second number on the same app is never ingested as ours).
5. **Templates:** submit every row of `docs/PRE_LAUNCH_CHECKLIST.md` 1.3 exactly (name, language, category, body,
   button). Telugu and Tamil bodies are machine drafts: native review first.
6. **Migration 0086** after the deploy (until then the code runs on the pre-ADR-030 rules and logs it once).

## Testing with the Meta test number

- Send **START** from a phone whose number is on the account (`users.phone`, stored `+91…`). Expect a
  `wa_conversations` row bound to the user, a `wa_messages` row (`direction=in`), the consent recorded
  (`wa_phone_consents`, by the dispatcher) and the opt-in confirmation (only with `AGENT_ENABLED=true` on the runtime).
- Send **STOP** → every purpose opted out, the one opt-out confirmation, then nothing.
- An outbound shows `queued` → `sent` → `delivered` → `read` on its row, with `pricing_category` and
  `cost_millipaise` once Meta bills it.
- Replay the same webhook body → no new rows (`vendor_message_id` unique).
- Offline proof any time: `pnpm --filter @amclub/web whatsapp:verify` (signature, parsing, templates, the send path).

## Rollback

`WHATSAPP_DRIVER=stub` (or remove the credentials) on web + runtime: outbound becomes a logged stub instantly, and the
webhook refuses every inbound POST (401), so nothing is ingested. Scale the runtime to 0 to stop it entirely.

## Privacy

Only vendor ids, phone (E.164) or BSUID, text and media object paths are stored. Card numbers and codes typed next to
OTP / PIN / CVV / password are removed before storing (shared `redactChatSecrets`, in the body and the stored payload;
`payload.amc_redacted` records what was removed). Media sits in a **private** bucket and is read via signed URLs.
Nothing here is exposed to a client role (admin / ops read only; consent rows are readable by their own user).

> **ADR-030 note on the sections below.** They record how each agent was wired when it landed. Since ADR-030 every
> send goes through `sendWhatsApp` (consent per phone and purpose instead of the grant-as-opt-in, the window with a
> margin, the ledger), templates exist in en / hi / te / ta, and the keyword rules are shared `classifyWaKeyword`
> (a greeting is not consent; "no" / "cancel" are not STOP). Where a section below says otherwise, ADR-030 wins.

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
(`button_reply` and `list_reply` both parsed). The stub logs. (Interakt, which
had no interactive payload, is removed — ADR-030.)

**Templates** (en/hi/te/ta since ADR-030): `onboarding_start`,
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
Content-Length, then a streamed byte cap (`WA_MEDIA_MAX_BYTES`, default 10 MB). A refusal is recorded (`refused:<code>`) and the message is still handled without media.

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
