# Follow-ups — logged, not built

Items deliberately deferred during pre-cutover hardening. Each entry says what
exists today, what is missing, and what would unblock it. Remove an entry when
it ships.

---

## Quote withdrawal (provider) — no UI, no route (logged 2026-08-27, Phase 1f)

**Today:** `quotes.status` supports `withdrawn` (state machine + `quote_events`
CHECK constraint + `provider_score_inputs_v1.quotes_withdrawn`), but **no code
path writes it** — there is no withdraw route and no UI affordance. A provider
who no longer wants to honour a quote can only let it be auto-declined or
expire, which the score view counts as *silence*, not an active decision.

**Needed:** `POST /api/v1/quotes/[quoteId]/withdraw` (provider-owned, only
from `submitted`, releases the RFQ quote slot via `release_quote_slot`, writes
`quote_events` `withdrawn` with the provider as actor + optional reason), a
"Withdraw quote" action on `/partner/rfqs`, and buyer notification. Decide
whether withdrawal after a buyer message should be allowed.

**Why deferred:** Phase 1 scope was event capture for statuses that already
have writers; adding a provider-facing action is product scope.
