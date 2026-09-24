# AGGREGATION.md — group requests for services (S3.4)

> **Built dark.** Four locks must all be open before anything runs for a person:
> - `AGENT_ENABLED=true` on the web app;
> - `agents_enabled.demand_aggregation`;
> - the person in `cohort_user_ids`;
> - migration **0071** applied (done on production, 2026-09-24).
>
> With any lock closed, the pages and routes 404, the cron records a no-op heartbeat, and nothing reads a 0071 table.
> **Enablement waits for the V1.5→V2 gate** (`ARCHITECTURE.md` §11, S3) and its own §8.1 note. Decision record: ADR 024.

## What it is

Several small businesses in one state often ask for the same service within a day of each other: GST annual returns, ITR season, licence renewals. The agent proposes a **group** of those buyers' own requests. Each buyer can opt in. Eligible providers state a **volume-tier offer** up front, for example "₹10,000 for one business, ₹8,000 each if 3 or more choose me". Each buyer then chooses one offer.

When the group closes, every buyer who chose an offer gets **one ordinary quote** on their own request, at the tier the count reached. From there it is the ordinary **Accept & pay**, order, escrow and payout. There is no new checkout, order state or money path.

The agent is **code only**; no model is involved:
- detection is shared `clusterPoolCandidates`;
- timing is shared `poolClosesAt`;
- tiers are shared `poolTierProblems` and `achievedTier`;
- the close is shared `planPoolClose`.

## The flow

| Step | Who | What happens |
|---|---|---|
| Propose | cron `agent-demand-pools` (hourly, :35) | It finds open, released services requests from cohort buyers and groups them by **(category, `details.service_slug`, buyer state)**, keeping each buyer's newest request. A request qualifies only if its own clock has room for the whole group (`pool_form_hours` + `pool_open_hours` + `pool_pay_buffer_hours`, 12 + 24 + 12 h) and it has **no must-haves**. A cluster of ≥ `pool_min_members` distinct buyers (3) becomes a **forming** group. Each member is `invited` and notified (`notify.pool_invite`). A later matching request is added to a live group while it still fits. A request is invited **at most once in its life**. |
| Join | buyer | On the request page, the card offers **Join the group** or **No thanks**. A join writes **one `ai_decisions` row** (feature `demand_pool`, tool `join_pool`) linked to the membership. The join that reaches the minimum opens the group: `closes_at` = the earlier of now + open hours and the earliest member expiry − pay buffer. Eligible providers and members are then told. |
| Offer | provider | Only a provider that is fan-out-matched to a joined member, active, and in the cohort can offer. It makes **one** sealed offer: 1–3 tiers (the first is `min_members = 1`; each next tier has more businesses and a strictly lower price; thresholds ≤ `pool_max_members`), plus days, scope, GST (required), validity (must last past the close) and an optional advance. Rule failures return 400 `tiers_incoherent`, 422 `validity_too_short` or 409 `offer_exists`. Withdrawing an offer clears the choices made for it. |
| Choose | buyer | A joined member picks one offer, or none. Choosing moves no money. An offer from a provider who already quoted, or declined, that member's own request directly is not available to that member. |
| Close | cron | Past `closes_at` the group moves `open → closing`. For each committed member the close runs: **pre-check** → `service_pool_claim` (the ordinary 7-cap slot, claimed and marked in one transaction) → the offer's **tier from its claimed count** (saved once on the offer) → **one ordinary quote** at that price (built with `resolveQuoteTerms` / `quoteRowColumns`, with a `submitted` quote event naming the group) → notify the buyer and the provider. The group then moves `closing → closed` and its memberships are `released`. |
| Lapse | cron | A forming group past `form_by` with too few members is `lapsed`; members are released and told that their request carries on. |
| Cancel | ops | `/admin/agents/pools`, **Cancel group**, with a reason (audited). Allowed on a forming or open group only. |

**Replay safety.**
- Every status write is guarded on the status it expects.
- A claimed member is never claimed twice: the function's row lock plus `claim_state`.
- The unique (request, provider) quote blocks a second quote. If a direct quote lands between the pre-check and the insert, the slot is released and the member is marked `skipped / already_quoted`.
- A close that stops half-way resumes on the next run with the saved tier.

**Privacy.** Buyers never see each other, only the count. Providers never see each other's offers or their commit counts. Pool tables have no client grant; the API reads them on the admin client after its own authorisation.

## Surfaces

| Surface | Route |
|---|---|
| Buyer card | `(msme)/app/rfq/[id]`: `PoolInviteCard`, rendered only when all four locks are open |
| Buyer group page | `(agent-pools-msme)/app/pools/[id]` |
| Provider list / offer | `(agent-pools-provider)/partner/pools`, `/partner/pools/[id]`. `/partner/rfqs` shows a banner when groups are open for them |
| Ops | `(agent-admin)/admin/agents/pools`: counts, plus committed → quoted → paid per group |
| API | `GET /api/v1/pools/[id]` (role-shaped), `POST …/membership`, `POST …/commit`, `POST|DELETE …/offer`, `GET /api/v1/rfq/[id]/pool`, `GET /api/v1/partner/pools`, `GET /api/v1/agent/admin/pools`, `POST /api/v1/agent/admin/pools/[id]/cancel`, cron `GET /api/v1/cron/agent-demand-pools` |
| Mobile | Not in v1 (reads the same `/api/v1`). See `docs/FOLLOWUPS.md` |

## Settings

These are registry keys, editable at `/admin/agents`:

| Key | Default | Meaning |
|---|---|---|
| `agents_enabled.demand_aggregation` | false | The switch |
| `pool_min_members` | 3 | Buyers needed to propose a group and to open it |
| `pool_max_members` | 20 | Largest group; also the highest tier threshold |
| `pool_form_hours` | 12 | How long a forming group waits for joins |
| `pool_open_hours` | 24 | How long an open group takes offers and choices |
| `pool_pay_buffer_hours` | 12 | Gap between the close and the earliest member request's expiry |

## Enabling (founder, in order)

1. **Migration 0071 is on production** (applied 2026-09-24; its five tables exist with RLS on). It is an agent migration and is not staged. It is additive, with no client grants, and widens the `ai_decisions` CHECK. Re-verify before enabling:
   ```bash
   MART_MIGRATIONS_EXPECTED=false pnpm --filter @amclub/web exec tsx scripts/verify-migrations.ts
   ```
2. Pass the V1.5→V2 gate, and write the §8.1 note. The note must show there is enough density: requests in the same category, service and state within a day.
3. Set `AGENT_ENABLED=true` on the web app. It is already the switch for every agent.
4. At `/admin/agents`: add a small cohort (buyers **and** the providers who serve them), then turn on `demand_aggregation`.
5. Watch `/admin/agents/pools`: committed → quoted → paid. A low paid-per-quoted rate is the honest-commitment risk named in ADR 024 §3.

## Rollback

- Turn `agents_enabled.demand_aggregation` off. Detection and the clock stop, the surfaces 404, and the cron beats as a no-op.
- A group left `open` or `closing` resumes when the switch returns. Cancel it from ops if it should not.
- Quotes already written by a close stay ordinary quotes at their stated price.
- 0071 can stay.

## Verification

- **Shared:** `service-pools.test.ts`, 17 tests: the machine, the tier rule, the timing rule, clustering and the close plan.
- **Rig:** `scripts/verify-pools.ts` runs in `money-rigs.yml` against a second server started with `AGENT_ENABLED=true` on :3001. The :3000 server stays flag-off for every other rig. It covers these sections:
  - 0: inert;
  - 1: detection;
  - 2: joining;
  - 3: offers;
  - 4: choices;
  - 5: close and replay;
  - 6: pay through the ordinary checkout;
  - 7: lapse and cancel.

  Fixtures are in Lakshadweep (LD); there is zero residue, and the agent settings it touched are restored.
