# WhatsApp ops and privacy operations — runbook (ADR-030 §6)

Who this is for: ops and the founder running the WhatsApp channel and answering data requests. Decision record:
`docs/adr/030-whatsapp-cloud-api-consent-and-ledger.md`; scope: `docs/prd/PRD_WHATSAPP.md` ("Privacy ops" row);
gaps it closes: `docs/audit/2026-09-26-whatsapp-readiness-audit.md` §3 (ops console), §6 (retention, erasure, transcript
access, corpus), §7 (the Support fees line). The data rule (no training / eval / corpus from WhatsApp content) is in
`docs/agents/SECURITY.md`.

Everything here needs the **admin or ops role**; every page and every route checks it (`requireAdmin`, which also
refuses delegated agent tokens — none of this is an agent tool). Reads run on the service role; phones are shown
masked (last four digits); secrets are never shown. Every mutation is rate-limited (admin limiter) and audit-logged
with before / after.

Migrations **0086** (WhatsApp ledger, consents, templates, account events, retention columns) and **0087**
(`dpdp_requests`) are applied **after** the code deploys. Until then each screen says "Not ready", the crons record a
degraded heartbeat with `notReady: true`, and nothing fails.

## 1. The console — `/admin/whatsapp`

| Tab | Shows | Route |
|---|---|---|
| Overview | Driver (`stub` / `meta_cloud`), live or not, whether each credential is **set** (booleans only), Graph version (`WHATSAPP_GRAPH_VERSION`, default `v24.0`), number quality and messaging tier from the latest `wa_account_events` (`phone_number_quality_update` / `account_update`), last inbound message, last status webhook, conversations (and how many are linked to an account). | `GET /api/v1/admin/whatsapp/overview` |
| Delivery log | Outbound messages of the last 7 days: time (IST), kind, template, language, status, error code / title, masked phone. Filters: kind, status, error code. Counts by status and the top error codes. **No bodies in the list.** "View" opens one message with its text — that read is audit-logged (`wa_message_read`). | `GET …/messages`, `GET …/messages/[id]` |
| Templates | `wa_templates` (Meta's copy) next to the code registry: name, language, category, status, rejection reason, synced time, and a check: **In code, not approved** (the send path will refuse it — submit or fix it), **Approved, not in code** (unused or renamed — clean it up in Meta), Approved, Not in code. "Sync now" pulls Meta's list (Graph `GET /{WHATSAPP_WABA_ID}/message_templates`, paginated, 10 s timeout per call) and upserts it; after a complete pass, rows Meta no longer lists are marked `deleted`. Audit: `wa_templates_sync`. | `GET …/templates`, `POST …/templates/sync` |
| Spend | Per IST day and category over 30 days: messages, billable, cost. Costs are summed as integer **millipaise** (1/1000 paise) from `wa_messages.cost_millipaise` and formatted to ₹ on the server. **Excl. 18 % GST.** The category is Meta's pricing category when the webhook reported one, else the one we sent under. | `GET …/spend` |
| Consents | Opted-in / opted-out phones per purpose (transactional, assistant, marketing), the last 50 opt-outs (masked, source, keyword), and suppressions with their reason, error code and expiry. | `GET …/consents` |
| Unrouted inbound | Inbound messages of the last 7 days from numbers with no linked account: masked phone, time, kind, first 80 characters (secrets removed). **Reply** is enabled only inside the person's 24-hour window (5-minute margin) and sends free text through `sendWhatsApp` (initiation `reply`, purpose `transactional`, one message per click). **Open ticket** works only when an AMClub account holds the number now (`users.phone`); otherwise it says so. Audit: `wa_ops_reply`, `wa_ticket_open`. | `GET …/unrouted`, `POST …/unrouted/[id]/reply`, `POST …/unrouted/[id]/ticket` |

### Clearing a suppression

Suppressions come from delivery errors (131026 not on WhatsApp, 131050 stopped marketing, repeated undeliverable). Clear
one when you know it is stale — e.g. the person tells support they now use WhatsApp on that number. **Clearing never
touches consent:** a STOPped phone stays opted out of every purpose (ADR-030 §2), and only the person can opt back in
(START or the settings toggle). The console addresses a suppression by an opaque key, never the number;
`DELETE /api/v1/admin/whatsapp/suppressions/[key]` writes `wa_suppression_clear` with the row as it was (phone masked).

## 2. Support tickets — `/admin/support`

- **Transcript scope (audit §6).** A WhatsApp ticket's transcript shows only the ticket user's own chat: messages on
  that conversation since `wa_conversations.bound_at` (its `created_at` where no bind time was recorded), and only while
  the user still holds the number — bound to them, or unbound and their current `users.phone`. A recycled or changed
  number shows nothing ("belongs to someone else now"). Rows carrying another user are never shown. Secrets and contact
  details are masked; redacted rows say "text removed".
- **Every transcript read is audit-logged** (`wa_transcript_read`, entity `support_ticket`, with the scope, the start
  time and the message count).
- **Replying.** The reply box sends through the one send path: inside the 24-hour window as free text (initiation
  `reply`); outside it as the approved `support_reply` template with `{ title: the ticket ref, body: your text }`
  (initiation `business`, needs the transactional opt-in); never to a number that is no longer the user's (409
  `number_changed`). Web / mobile tickets get the reply in their support chat plus an in-app notice. An open ticket
  moves to in progress. Audit: `support_ops_reply` (without the text). Route:
  `POST /api/v1/agent/admin/support/tickets/[id]/reply`.

## 3. Retention — cron `wa-retention` (daily 22:50 UTC = 04:20 IST)

Settings (edit on `/admin/agents`; registered in `packages/shared/src/agent-settings.ts`):

| Key | Default | What |
|---|---|---|
| `wa_retention_text_days` | 180 | message text, voice transcripts and payloads are redacted (`redacted_at` set; ids, kind, status and times stay) |
| `wa_retention_media_days` | 90 | `wa-media` objects are deleted and the reference cleared (the text stays until the text period) |
| `wa_retention_unknown_days` | 30 | the conversation of a number that never bound to an account, quiet for that long, is deleted with its messages and media |
| `dpdp_due_days` | 30 | the answer period of a DPDP request (below) |

**Held — never touched:** a row with `legal_hold = true`; any message of a user with an open support ticket, an order
whose work, refund or dispute is still open (shared `WA_HOLD_ORDER_STATUSES`: in flight, refund owed, disputed). A
number counts as "ever had an account" (so it is not deleted as unknown) when it has a ticket, a message carrying a
user, a legal hold, a consent event with a user, or a WhatsApp grant given from it. If a hold lookup fails, the batch
is held (retention never deletes on a guess). Consent events (`wa_consent_events`) are **never** deleted: they are
the legal proof of what the phone agreed to.

Mechanics: batches of 200 (conversations 100), at most 5,000 rows per step per run, inside a 300 s budget
(`timeBudget`); media objects are removed before the row forgets them, so a failed delete is retried the next day.
Heartbeat result: `{ notReady, settings, scanned, redacted, mediaRemoved, mediaObjectsDeleted, conversationsDeleted,
held, errors, partial }`. **Degraded** (amber on `/admin`) when `errors > 0` or `notReady`. `partial: true` only means
the budget ran out; the rest runs tomorrow.

Run by hand (a disposable or staging stack): `curl -H "Authorization: Bearer $CRON_SECRET" <app>/api/v1/cron/wa-retention`.

## 4. Template sync — cron `wa-template-sync` (daily 01:20 UTC)

Same pull as "Sync now". Not configured (`WHATSAPP_WABA_ID` or the access token missing) → an ok beat with
`skipped: 'not_configured'`. Before 0086 → `notReady` (degraded). A Graph error → `errors: 1` with Meta's message
(degraded). The access token never appears in a log or a heartbeat.

## 5. DPDP requests — `/admin/privacy`

Requests arrive from the web, the mobile app and WhatsApp ("MY DATA", "DELETE MY DATA"); ops can also record one
received by email or letter ("Record a request": the account by id, email or phone). Each gets `due_at = created +
dpdp_due_days`. The queue shows open work first by due date and flags **overdue** in red; the retention settings and
the last `wa-retention` run sit above it.

Statuses (shared `DPDP_REQUEST_TRANSITIONS`): `open → in_progress → done | rejected` (open may go straight to done /
rejected); done and rejected are final; every change is compare-and-set (409 `changed` if someone else moved it) and
audit-logged (`dpdp_request_<action>`). Done and rejected need an answer of at least 10 characters — **the user reads
it** — and send them an in-app notice.

- **Access.** "Download data export" builds one JSON file (`amclub-dpdp-access-v1`): the account, business profiles
  (secrets left out), an orders summary (buyer and provider), requests, consents (WhatsApp events and state, agent
  grants, analytics and corpus choices), the WhatsApp messages of the account's conversations, notifications and their
  DPDP requests. Every download is audit-logged (`dpdp_export`). Send it to the person over a verified channel, then
  mark the request done.
- **Erasure.** Marking an erasure request done runs the WhatsApp erasure first: every message of the account's
  conversations (and every message carrying the user) is redacted and its media deleted, the conversations are
  unbound (user, bind time and routes to sessions / ticket cleared), and the WhatsApp agent grants are revoked. Kept:
  rows on legal hold (counted), consent events (legal proof), the `users` row, and the orders, invoices and payment
  records the law requires us to keep. The server appends a fixed sentence saying exactly this to your answer, in the
  user's language (`dpdp_answer` messages). If any step fails nothing is marked done (500 `erasure_incomplete`; safe to
  retry). If the number is still the account's phone, a later message starts a fresh conversation: that is new data.
- **Correction / withdrawal / grievance / nomination.** Do the work where it lives (profile, consent toggles, the
  grievance process) and record what you did as the answer.

## 6. Audit actions (search on `/admin/audit`)

`wa_message_read`, `wa_transcript_read`, `wa_templates_sync`, `wa_suppression_clear`, `wa_ops_reply`,
`wa_ticket_open`, `support_ops_reply`, `dpdp_request_create`, `dpdp_request_in_progress`, `dpdp_request_done`,
`dpdp_request_rejected`, `dpdp_erasure_incomplete`, `dpdp_export`.

## 7. Proof

`apps/web/scripts/verify-whatsapp-ops.ts` (CI, disposable Supabase): admin routes refuse a non-admin and a delegated
token; the retention job redacts an old row and keeps a legal-hold row and a held user's row; a never-bound number is
deleted and a known one kept; the DPDP lifecycle (record → in progress → done, illegal transitions refused, access
export audited, erasure redacts and revokes and the answer carries the fixed sentence); a WhatsApp transcript read
writes `wa_transcript_read` and never shows a previous holder's messages. Pure rules: `packages/shared/src/__tests__/
wa-ops.test.ts` (retention eligibility, millipaise formatting, masking, redaction, templates, DPDP transitions) and
`packages/agent-core/src/procurement/channel.test.ts` (the corpus tag).
