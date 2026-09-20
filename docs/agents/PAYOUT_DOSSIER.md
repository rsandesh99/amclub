# PAYOUT_DOSSIER.md — the Payout-Evidence agent (S1.4)

**What it is.** When an order completes (services: buyer accepts delivery or
the 72 h auto-accept; goods: buyer received) and its payout is born **held**
(ADR-002), a runtime agent assembles a *dossier*: deterministic checks, vision
findings for the evidence photos, anomaly flags, and a recommendation computed
by a fixed rule. It then sends the founder a one-tap **Approve / Hold**.

**What it is not.** It never releases money. *Approve* is the founder's own tap
on `/admin/payouts`, which calls the existing release route
(`POST /api/v1/admin/payouts/[id]`) — the same button as before, now also
closing the dossier. *Hold* does **nothing**: the payout simply stays held.
`PAYOUT_AUTO_RELEASE` semantics and ADR-002 are unchanged (see its 2026-09-20
note). No agent tool wraps the release route, and any delegated (agent) token
presented there is refused with 403.

Persona: **ops**, read-only. The agent's only data path is one admin read,
`GET /api/v1/admin/orders/[id]/evidence`, under the founder's delegated ops
token (RLS + `requireAdmin` + `requireToolScope('read_order_evidence')`). The
service role is used only for the agent's own telemetry
(`agent_runs` / `agent_events` / `ai_invocations`, `payout_dossiers`,
`evidence_photo_hashes`) and to read `agent_settings`.

---

## Turning it on (one-time bootstrap; nothing runs until all four are true)

1. **`AGENT_ENABLED=true`** on the web app (Vercel) *and* the runtime deployed
   (`docs/agents/RUNTIME.md`) with `AGENT_RUNTIME_URL` + `AGENT_RUNTIME_SECRET`
   set on the web app.
2. **Ops grant.** The founder (an `admin` user) opens their profile → *AI
   assistant* section (S0.2) and creates a grant: persona **ops**, scopes
   `read_order_evidence` + `recommend_payout_release`, channel **web**.
   (Equivalent: `POST /api/v1/agent/grants` with that body under their session.)
3. **Settings** at `/admin/agents`:
   - `ops_user_id` = the founder's user id (must hold `admin` + the grant above);
   - `agents_enabled.payout_dossier` = true;
   - `cohort_user_ids` includes the founder's user id (registry rule: an agent
     runs only for cohort members; this agent runs *on behalf of* the ops user);
   - optionally `dossier_max_photos` (default 6) and `dossier_dup_hamming_max`
     (default 6).
4. For services orders the evidence engine must be enforced
   (`evidence_required_from` set, S0.3) if you want `work_complete_photo` to be
   meaningful; the agent still runs without it and simply reports what it finds.

**Turning it off:** `agents_enabled.payout_dossier=false` at `/admin/agents`,
or the kill switch (all agents), or `AGENT_ENABLED=false`. Existing dossiers
stay readable; payouts are unaffected either way.

---

## What each check means

| check | ok when |
|---|---|
| `milestones_complete` | services: all four milestone kinds recorded (`accepted`, `site_or_materials`, `in_progress`, `work_complete`); goods: `dispatched`, `delivered_photo` and `buyer_received` (or auto-accept) events exist |
| `work_complete_photo` | services: the `work_complete` milestone carries a photo; goods: a delivery photo exists |
| `buyer_confirmed` | `orders.completed_at` is set (buyer tap or the 72 h auto-accept) |
| `amount_matches_accepted` | captured payments total == `orders.total_paise`, `payouts.amount_paise` == `orders.provider_earning_paise`, and the frozen checkout session (when found) matches the order totals |
| `no_open_dispute` | no dispute in `open` / `under_review` |
| `payout_is_held` | the payout row is `held` (the dossier is about a held payout) |
| `provider_payout_ready` | bank penny-drop verified, Razorpay Route account present, provider `active` — a release tap would otherwise fail |
| `photos_plausible` | every vision finding passes the thresholds (below) |
| `no_duplicate_photos` | no evidence photo is a dHash near-duplicate (≤ `dossier_dup_hamming_max` bits) of a photo from a **different** order by the same provider |
| `timeline_consistent` | milestone timestamps are monotonic and after the order was placed; completion is after the last evidence photo |

Every check is always present. A missing check is itself a hold.

## Reading the photo findings

The vision model (task class `photo_plausibility`, frontier tier, prompt
`photo_plausibility@v1`) returns, per image: `looks_like_work`,
`matches_stage`, `is_screenshot_or_document`, up to five short `concerns`, and
a `confidence` 0..1. **Findings are findings, never a decision.** A finding
*passes* only when `looks_like_work && matches_stage &&
!is_screenshot_or_document && confidence >= 0.6`. Milestone notes written by
the provider reach the model only inside `<untrusted>` envelopes; the prompt
states they are data. A photo the model did not return a finding for counts as
failing.

## The recommendation rule (`recommendDossier`, `@amclub/shared`)

`approve` only when **every** check is ok, there are **no** anomalies, and
**every** finding passes. Otherwise `hold`, with the failing items as the
rationale (`check:<name>`, `anomaly:<a>`, `photo:<doc_id>:<why>`). The model
output cannot flip this on its own. Anomalies: `amount_mismatch`,
`completion_before_evidence`, `dispute_open`,
`duplicate_photo:<doc_id>~<prior_doc_id>`.

## The founder's two buttons

- **Approve & release payout** — calls `POST /api/v1/admin/payouts/[id]` with
  `{ action: 'retry', dossier_id, note? }`. The existing gates still apply
  (goods release gate, services evidence gate, payout state machine); the
  button is disabled while a gate holds and shows the reasons. On success the
  payout is rescheduled and settled as before, one `ai_decisions` row is
  written (feature `payout_dossier`, `run_id`, tool
  `recommend_payout_release`, final `{decision:'approve'}`), and the dossier's
  decision columns are written **once** (DB trigger; a second tap is 409).
- **Hold** — calls `POST /api/v1/agent/admin/dossiers/[id]/decision`
  `{ decision: 'hold', note }` (note required in the UI). Writes the same kind
  of `ai_decisions` row with `{decision:'hold'}` and closes the dossier.
  **Nothing else happens** — the payout stays held exactly as it was.

Where: `/admin/payouts` (a *Dossier* button on rows that have one; the
notification deep link `/admin/payouts?dossier=<id>&action=approve|hold`
opens the panel with that button focused — never auto-submitted) and
`/admin/orders/[id]`. `/admin/agents` shows a *Payout dossiers* tile
(pending count, median completed→decision minutes, approve rate, 30 days).

## Notification

Kind `payout_dossier_ready` → the ops user, channels in-app + email +
WhatsApp. WhatsApp delivery arrives automatically with the S0.5 rails
(template `amc_payout_dossier_ready_{en,hi}`, opt-in gated — the founder sends
START from their own number once). Sent once per dossier: the runtime calls
`POST /api/v1/agent/admin/dossiers/[id]/notify` with its credential and the
route claims `notified_at` before dispatching.

## Cost

One frontier-tier vision call per dossier with ≤ `dossier_max_photos` images
(re-encoded to ≤ 1024 px JPEG). Keyless / CI: ₹0 (stub). **Observed live cost
per dossier: not yet recorded** — there is no LLM key in this environment;
record the first ten live dossiers' `model_cost_paise` here after enablement
(the value is also on every dossier panel and summed on `/admin/agents`). The
default run budget (`budget_run_paise` = ₹20) is ample.

## Failure modes (no retry storms)

The job runs on pg-boss queue `agent.payout_dossier` with `retryLimit 2,
retryDelay 300 s`. Terminal (never retried): `agent_disabled` (web flag off →
token exchange 404), `no_ops_grant` (403), budget/step caps, authz,
`evidence_read_failed:4xx`. Network/5xx/DB errors retry twice.

## Verification

```bash
pnpm --filter @amclub/shared test                      # recommendDossier table, schemas
pnpm --filter @amclub/agent-core test                  # checks() fixtures, dHash, gateway images, runner route
pnpm --filter @amclub/agent-core eval --set photo_plausibility   # golden images (stub in CI; ≥80 % live)
pnpm --filter @amclub/web agents:verify                # every /api/v1/agent/* 404s while dark (incl. dossiers)
pnpm --filter @amclub/web agents:verify:dossier        # OFFLINE + flag-off; LIVE lifecycle with DOSSIER_VERIFY_LIVE=1
```

Golden images are synthetic (`packages/agent-core/scripts/gen-photo-fixtures.ts`):
blank walls, bar-"documents", UI frames, noise+shape "work" photos and two
near-duplicates for the dHash check.
