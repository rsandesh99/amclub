# ADR-030 — WhatsApp on Meta's Cloud API: consent, suppression, one send path, the notification outbox

**Status:** Accepted (founder, 2026-09-26: "go ahead build and fix everything" on the WhatsApp readiness audit).
**Context:** `docs/audit/2026-09-26-whatsapp-readiness-audit.md` (eight blockers before a live number), the founder's
strategy report (direct on the Cloud API, no BSP), `docs/prd/PRD_WHATSAPP.md` (§8.1 bundle).
**Supersedes:** the "Gupshup / Interakt" line of DESIGN §2.2; DESIGN §5.5 "transactional only, no marketing path" is
narrowed to "no marketing without its own consent and cap" (the campaigns path is built dark, PRD W3).

## 1. Vendor

AMClub sends and receives WhatsApp directly on Meta's Cloud API with its own number. No Business Solution Provider in
the product path; the Interakt driver is removed. MSG91 stays for SMS (DLT) and the Supabase OTP hook. The Graph API
version is pinned in validated env (`WHATSAPP_GRAPH_VERSION`, default the current stable) and a scheduled check warns
90 days before it expires. The production WhatsApp Business Account is created in INR.

## 2. Consent belongs to a phone and a purpose

- Purposes: `transactional` (orders, requests, payments), `assistant` (the assistant writing first), `marketing`.
- Every opt-in / opt-out is an append-only `wa_consent_events` row (phone, user, purpose, action, source, notice
  version, the keyword or button actually used, the inbound message id); `wa_phone_consents` holds the current state.
  Both are written only by `record_wa_consent()` (service role). Clients read their own rows.
- Opt-in: START or a button on WhatsApp; the WhatsApp checkbox at signup and checkout; the toggles in settings (web and
  mobile). A greeting ("hi", "ok", "yes") is never consent; it gets the HELP menu.
- Opt-out: STOP / UNSUBSCRIBE (en, hi, te, ta; punctuation and "please" tolerated) or the settings toggle. STOP opts
  the phone out of **every** purpose and revokes its WhatsApp agent grants. "No" / "cancel" are never an opt-out.
- **After STOP nothing goes on WhatsApp** except the one opt-out confirmation. Order and payment updates continue by SMS,
  email and in-app (founder decision D-WA1). `WA_ALWAYS_ALLOWED_KINDS` is removed: every business-initiated WhatsApp
  message needs the purpose's opt-in.
- A direct reply to the user's own message inside the 24-hour window needs only "not STOPped" (it is service, not a
  business-initiated message).
- Consent is separate from agent delegation. `agent_grants` (server-written, 0085) says what an agent may do; START
  creates a WhatsApp grant for **each persona the user holds** (fixes audit B3), STOP revokes them all.
- Delivery-driven suppression (`wa_suppressions`) comes from error codes (131026 not on WhatsApp, 131050 stopped
  marketing, repeated undeliverable); Meta sends no "blocked" event.

## 3. One send path

`sendWhatsApp()` (agent-core) is the only caller of a driver's send methods, for the web dispatcher and every runtime
agent: consent + suppression check → window decision (free-form inside the window with a margin, else the registry
template) → outbound row written first under a unique idempotency key → driver call with a timeout → classified error
→ outcome on the row. The webhook updates the same row with delivery status (never backwards), error code and
Meta's pricing object; cost is recorded in millipaise (integers, rule 6) from a rate registry in settings.

Templates are resolved by kind and locale to a (name, language) pair that exists; a missing locale falls back to en
with the en language code. The registry records each template's category; a template Meta re-categorised or paused
is refused before sending. Template copy is fixed text with typed parameters and URL buttons to our own domain.

## 4. Notifications: registry, preferences, outbox, fallback

- `NOTIFICATION_KINDS` (shared) is the one event → channel registry: category, default channels, essential, urgent,
  WhatsApp purpose. Call sites name the kind; they no longer pick channels.
- Users choose channels per category (`notification_preferences`), quiet hours in IST, a pause, and a lead digest
  (`notification_settings`). Essential kinds cannot lose every external channel; urgent kinds ignore quiet hours.
- Every external send is a `notification_outbox` row (idempotent per notification and channel) processed by a cron
  with retry and backoff. A WhatsApp that fails, is not allowed, or goes to a phone not on WhatsApp falls back to SMS
  (MSG91 DLT templates) and email for essential kinds. Closes audit M37.
- Reminder crons (accept-by, review-by, request / quote expiring, pay-by) claim `notification_reminders` rows so each
  reminder is sent once.

## 5. The assistant on WhatsApp stays scoped in code

Meta's Business Solution Terms bar general-purpose assistants and any training on WhatsApp data (including derived
or aggregate data). Every inbound message goes through one router; off-topic text gets a fixed steer-back (never a
model answer and never a human escalation); WhatsApp content is excluded from our corpus and eval sets; model calls
carry the no-retention preference.

## 6. Privacy operations

Retention: text and media of `wa_messages` are redacted after the configured periods unless linked to an order,
dispute or ticket (legal hold); conversations from numbers that never signed up after a shorter period. DPDP requests
(access, correction, erasure, withdrawal, grievance) are recorded in `dpdp_requests` from web, mobile and WhatsApp
("MY DATA", "DELETE MY DATA") with a due date, worked from the admin console. Ops reads of chat transcripts are
audit-logged and scoped to the current holder of the phone.

## Consequences

- Migrations 0086 (WhatsApp ledger) and 0087 (outbox, preferences, reminders, DPDP) — additive; code tolerates their
  absence until applied.
- Nothing changes for users until the founder provisions the Meta number, approves the templates and sets the env; the
  new notification behaviour (outbox, preferences, SMS fallback) is live once 0087 is applied and MSG91 is configured.
- Rig criteria: consent / STOP / suppression / window / idempotency in agent-core tests and `verify-whatsapp`; the
  outbox, fallback and preferences in a new `verify-notifications` rig in money-rigs.
