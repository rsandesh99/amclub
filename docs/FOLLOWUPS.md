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

---

## Real penny-drop vendor — LIVE-CUTOVER BLOCKER (logged 2026-08-27, Phase 1g)

**Today:** `penny_drop_verified` is server-set from `/kyc/verify-bank`; the dev
stub (no `KYC_API_KEY`) never counts. Genuine providers therefore land at
`bank_unverified` and are cleared by the admin `set_bank_verified` override
(reason required; `audit_logs` + `bank_account_verifications` with
`provider = 'admin_override'`, always distinguishable from a vendor result).

**Hard edge:** the override is fine while onboarding is manual. It must not be
the norm at real-money volume — provision Surepass/Signzy (`KYC_API_KEY`)
before live cutover. Tracked in ADR-003's cutover procedure.

---

## KYC vendor integration (Surepass/Signzy) — scope (logged 2026-08-28)

**Today:** `lib/kyc/surepass.ts` exists behind `KYC_API_KEY`; without a real
key the stub answers and never counts as verified. **Needed:** provision the
key, confirm the GSTIN + bank penny-drop endpoints against the sandbox, record
vendor request/response ids in `bank_account_verifications.result`, and add a
kill-test that a vendor *failure* leaves `penny_drop_verified=false`.
**Estimate:** 1–2 days once the account exists. Live-cutover blocker.

---

## Linked-account API automation (Razorpay Route) — scope (logged 2026-08-28)

See `docs/ROUTE_ONBOARDING.md` → "Follow-up". `accounts.create` →
`stakeholders.create` → `products.request` → document upload at admin
approval, storing the `acc_…` via the existing `set_route_account` action so
audit + readiness stay unchanged. Failures surface as *not ready*, never as a
fake id. ~2–3 days incl. test-mode Route sandboxing.

---

## Refund / transfer settlement webhooks + money journal — Phase 5 remainder (logged 2026-08-28)

**Today:** `refunds.status='processed'` and `payouts.status='paid'` are set
when the API call returns, not when Razorpay settles; the webhook handler
ignores `refund.*` and `transfer.*` events (Phase 0 §0d). **Needed:** handle
`refund.processed` / `refund.failed` / `transfer.processed` / `transfer.failed`
idempotently (same raw-body HMAC path), and add an insert-only `money_journal`
(payment_captured, refund_created, refund_settled, transfer_created,
transfer_settled, commission_earned) so the escrow balance is reconstructible
at any timestamp from our own tables. Additive; `payout.ts` remains the only
money-out path. ~3 days + a replay kill-test per event type.

---

## Provider Addendum — add the fee-bearing sentence at the next version bump (logged 2026-08-28, ADR-004)

Queue for `legal.provider_addendum_s1_p` (or a new §6) when
`LEGAL_VERSIONS.provider_addendum` is next bumped: *"You receive your full
quoted amount minus only AMC's 5% commission. All payment gateway charges are
borne by AMC."* Provider-favourable, so no urgency and no forced re-acceptance
now; it is already shown on `/partner/earnings` and `/help`.

---

## Route transfers: payment-linked vs direct, and live-mode account ids (logged 2026-08-28, pre-cutover money check)

**Today:** `lib/payments/razorpay.ts` calls `transfers.create({ account, amount })`
— a *direct* transfer from the platform's settled balance, **not** linked to
the buyer's payment. Consequences at cutover: (1) transfers before Razorpay
settles the payment (T+2/T+3) fail with insufficient balance; (2) the
escrow story ("held by the payment partner") is only literally true with
payment-linked transfers (`payments.transfer(paymentId, { transfers })`),
which draw from the captured amount and honour Route's F1/F2 rules.
**Founder decision needed** before switching: payment-linked transfers
(recommended; requires threading `razorpay_payment_id` into `createTransfer`
and keeping the transfer-then-refund order already adopted) vs staying direct
(needs a balance-aware retry). Either way `payout.ts` stays the only path.

**Account ids:** nothing in code assumes live-mode ids (the only check is the
`acc_` format), but Razorpay linked accounts are **per mode** — an `acc_`
created in test mode does not exist in live mode. Any test-mode id stored in
`provider_bank_accounts.razorpay_route_account_id` must be replaced with the
live-mode id at cutover (transfer would fail loudly otherwise; readiness
cannot tell the two apart). Added to `docs/ROUTE_ONBOARDING.md` checklist.

---

## Notification abstraction for WhatsApp (Gupshup/Interakt) — scope (logged 2026-08-28)

**Today:** `lib/notifications/channels.ts` has SMS (MSG91, not billed until
go-live), email (Resend) and an in-app channel; WhatsApp is a stub behind
`WHATSAPP_API_KEY`. **Needed:** one `sendTemplate(channel, template, vars)`
abstraction with per-channel adapters and DLT/WhatsApp template ids in config,
delivery-status callbacks recorded per notification, and a sandbox-delivered
template as the done-criterion (§6 Phase 6). ~2 days after template approval.
