# Pre-launch checklist — founder-gated externals

Things only the founder can do, which **enable** features that are already
built and shipped dark. Referenced by `BUILD_PROMPTS.md` ("How to run this
plan" §3), `docs/agents/README.md`, and `docs/COMPLIANCE.md`.

## Track 1 — vendors & credentials

### 1.1 Razorpay live keys + Route
Live `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET`; Route linked accounts per provider
(`set_route_account` in /admin/providers). See `docs/adr/004-*` and
`docs/mart/LAUNCH_RUNBOOK.md`.

### 1.2 MSG91 + DLT
`MSG91_AUTH_KEY`, DLT entity + template registration for transactional SMS.

### 1.3 WhatsApp BSP / Meta (S0.5 rails are built; this turns them on)
Setup steps: `docs/agents/WHATSAPP.md`. Choose **one** driver.

Env to set (web + runtime): `WHATSAPP_DRIVER`, and for Meta
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN`; for Interakt `INTERAKT_API_KEY`,
`INTERAKT_WEBHOOK_SECRET`. Web only: `NEXT_PUBLIC_WHATSAPP_NUMBER`.
Runtime only: `AGENT_ENABLED=true` (lets the inbound job reply).

**Templates to submit for approval** (utility category; the `_en` and `_hi`
variants of each — exact names, one `{{1}}` title + `{{2}}` body param unless
noted; these are what `packages/agent-core/src/whatsapp/templates.ts` sends):

| kind | template names |
|---|---|
| order_placed | `amc_order_placed_en`, `amc_order_placed_hi` |
| order_accepted | `amc_order_accepted_en`, `amc_order_accepted_hi` |
| requirements_submitted | `amc_requirements_submitted_en`, `amc_requirements_submitted_hi` |
| order_in_progress | `amc_order_in_progress_en`, `amc_order_in_progress_hi` |
| order_delivered | `amc_order_delivered_en`, `amc_order_delivered_hi` |
| order_completed | `amc_order_completed_en`, `amc_order_completed_hi` |
| order_cancelled | `amc_order_cancelled_en`, `amc_order_cancelled_hi` |
| order_auto_cancelled | `amc_order_auto_cancelled_en`, `amc_order_auto_cancelled_hi` |
| order_disputed | `amc_order_disputed_en`, `amc_order_disputed_hi` |
| revision_requested | `amc_revision_requested_en`, `amc_revision_requested_hi` |
| milestone_added | `amc_milestone_added_en`, `amc_milestone_added_hi` |
| review_prompt | `amc_review_prompt_en`, `amc_review_prompt_hi` |
| rfq_matched | `amc_rfq_matched_en`, `amc_rfq_matched_hi` |
| rfq_new_quote | `amc_rfq_new_quote_en`, `amc_rfq_new_quote_hi` |
| rfq_providers_unavailable | `amc_rfq_unavailable_en`, `amc_rfq_unavailable_hi` |
| quote_accepted | `amc_quote_accepted_en`, `amc_quote_accepted_hi` |
| quote_declined | `amc_quote_declined_en`, `amc_quote_declined_hi` |
| quote_message | `amc_quote_message_en`, `amc_quote_message_hi` |
| payout_paid | `amc_payout_paid_en`, `amc_payout_paid_hi` |
| payout_dossier_ready (S1.4, ops user; opt-in gated) | `amc_payout_dossier_ready_en`, `amc_payout_dossier_ready_hi` |
| (system, no params) opt-in confirmed | `amc_wa_opt_in_en`, `amc_wa_opt_in_hi` |
| (system, no params) opt-out confirmed | `amc_wa_opt_out_en`, `amc_wa_opt_out_hi` |
| (system, no params) holding reply | `amc_wa_holding_en`, `amc_wa_holding_hi` |

Webhook: `https://<agent-runtime>/webhooks/whatsapp` (Meta: verify token; Interakt: `x-interakt-secret` header).

### 1.4 Surepass (KYC) production key
`KYC_API_KEY` — enables real GSTIN, bank penny-drop and (S0.4) Udyam
verification; the dev stub never sets a verified flag.

### 1.5 CA opinion
TDS section/rate (`mart_settings.tds`) and the fee-bearing line (ADR-004).

## Track 2 — counsel
Terms/privacy/provider addendum sign-off (`docs/COMPLIANCE.md`).

## Agent programme enablement (per cohort, DESIGN.md §8.2)

### Payout-Evidence agent (S1.4) — ops grant bootstrap
Founder-only, one time, in this order (details: `docs/agents/PAYOUT_DOSSIER.md`):
1. Runtime deployed + `AGENT_RUNTIME_URL`/`AGENT_RUNTIME_SECRET` on the web app; `AGENT_ENABLED=true`.
2. Create the ops grant from your profile's *AI assistant* section: persona **ops**,
   scopes `read_order_evidence`, `recommend_payout_release`, channel **web**.
3. `/admin/agents`: set `ops_user_id` (your user id), add it to `cohort_user_ids`,
   then flip `agents_enabled.payout_dossier`.
4. Optional: send START from your own WhatsApp number once the S0.5 rails are live
   to receive the one-tap there too.

Fly: `FLY_API_TOKEN`; web: `SUPABASE_JWT_SECRET`, `AGENT_RUNTIME_SECRET`,
`AGENT_RUNTIME_URL`; LLM key. Then `AGENT_ENABLED=true` and flip each agent in
`/admin/agents` with a cohort (`docs/agents/RUNTIME.md`).
