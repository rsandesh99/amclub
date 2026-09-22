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
                                                              │ media → private bucket `wa-media`
                                                              └► pg-boss `wa.inbound` → START/STOP/holding reply
 web dispatcher (createNotification … channels:['whatsapp']) ──► agent-core sendTemplate (approved templates only)
```

- **Adapter**: `packages/agent-core/src/whatsapp` — `WhatsAppProvider` interface;
  drivers `meta_cloud`, `interakt`, `stub`; picked by `WHATSAPP_DRIVER` **and**
  the driver's credentials (missing creds ⇒ stub).
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
becomes a logged stub instantly; the webhook keeps storing inbound messages.
Scale the runtime to 0 to stop ingesting.

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
private `wa-media` bucket at `<conversationId>/<vendorMessageId>.<ext>`;
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

## S1.4 note — founder one-tap

The Payout-Evidence agent notifies the ops user by kind `payout_dossier_ready`
(template `amc_payout_dossier_ready_{en,hi}`, opt-in gated: the founder must
have an active WhatsApp grant from their own START). The message deep-links to
`/admin/payouts?dossier=<id>`; Approve/Hold are taps on the web panel, never
in-chat replies. Add the template to the approval batch in PRE_LAUNCH_CHECKLIST 1.3.
