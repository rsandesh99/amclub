# ADR 024 — Demand aggregation for services: group requests with volume-tier offers (S3.4)

**Status: Accepted 2026-09-24 for a DARK build.**
- It touches money (quotes that become orders) and adds an agent, so it goes through §8.4.
- It ships behind `AGENT_ENABLED` + `agents_enabled.demand_aggregation` + the cohort allowlist. Every switch defaults off.
- Enabling it for any cohort waits for the **V1.5→V2 gate** (`docs/agents/ARCHITECTURE.md` §11: S3 enablement) and its own §8.1 note.

## 1. Context

`BUILD_PROMPTS.md` S3.4 is the "Demand-Aggregation Agent (services pools) + tiered quotes". The founder's resume note (2026-09-24) says its tiered quotes reuse the E12b `quote_options` design (ADR 020).

- **The opportunity.** Compliance work clusters: GST annual returns, ITR season, licence renewals. Several small businesses in one state post the same need within a day of each other. A provider can do ten identical filings for less per filing than one, but today each buyer gets a one-off price.
- **What already exists.**
  - Goods group buys (Mart M1, ADR 006): the seller's own bulk tier, pay-on-close, one ordinary order per member.
  - Quote speed options (ADR 020): provider-stated alternatives on a quote, immutable rows, service role only, a shared coherence rule, and the buyer only picks.
- **What the rules forbid.**
  - §8.3 and PRD Experience v3 A.5: no auctions, no negotiation, no "request a discount from several suppliers" (ADR 013).
  - §3.7: no new order states and no repurposed transitions.
  - ADR 018: money rows are server-written.
  - The 7-quote cap and the RFQ's 72-hour clock are unchanged (S1.3 left them untouched on purpose).

## 2. Decision

### 2.1 A pool is a group of the buyers' own requests

- **Pool key.** A services pool is keyed by **(category, service, buyer state)**. The service is the v3 form's `details.service_slug`.
  - A request without a service is never pooled.
  - Neither is one with must-haves: a group is for the standard version of a service.
- **Members.** Each member is **one buyer's own open request** (`rfqs` row).
  - The request stays exactly what it was: its own fan-out, its own direct quotes, its own 72-hour clock.
  - Joining a group adds a way to receive one more quote, a group price. It never replaces anything.
- **Buyer privacy.** Buyers never see each other. A member sees only the count ("you and 4 other businesses in Telangana"), never another member's request.

### 2.2 The agent proposes; the buyer disposes

**Detection** (`cron/agent-demand-pools`, hourly; code, no model) is the shared rule `clusterPoolCandidates`. It groups open, released (`fanout_at` set) services requests from cohort buyers by key. It keeps the newest request per buyer.

A request is a candidate only when its `expires_at` leaves room for the whole pool:

    form_hours + open_hours + pay_buffer_hours

The defaults are 12 + 24 + 12. This way a group price always arrives while the buyer can still pay it, and the RFQ clock never has to move.

A cluster of at least `pool_min_members` buyers (default 3) becomes a `forming` pool, and each of its requests gets an `invited` membership. A later request with the same key joins the invite list of a pool that is still forming or open.

**Joining is the buyer's tap on the agent's proposal.** It writes one `ai_decisions` row (feature `demand_pool`, tool `join_pool`). A buyer may also dismiss the invitation, or leave later.

### 2.3 The pool machine (shared `SERVICE_POOL_TRANSITIONS`)

```
forming → open        (joined ≥ min_members; closes_at fixed at this moment)
forming → lapsed      (form_by passed with too few members)
open    → closing     (closes_at passed; the close has started)
closing → closed      (every committed member settled)
forming | open → cancelled   (ops)
```

- **Guards.** Every write is guarded on the status it expects, so a replay does nothing.
- **Closing.** `closes_at` is the earlier of two times:
  - `opened_at + open_hours`;
  - the earliest joined member's `expires_at − pay_buffer_hours`.
- **Membership statuses.** `invited`, `joined`, `left`, `dismissed`, `released`. A partial unique index keeps a request in at most one live pool (`invited` or `joined`).

### 2.4 Volume-tier offers: the E12b design, applied to a count

A provider eligible for the pool may submit **one** group offer while the pool is open. Eligible means all three:
- the provider is fan-out-matched to at least one joined member;
- the provider is active;
- the provider is in the cohort.

**Contents of an offer.**
- Scope, delivery days and message.
- **GST statement (required).** ADR 017: a quote never leaves GST unsaid.
- **Validity (required)**, and an optional advance.
- **1 to 3 tiers.** Each tier is (`min_members`, `price_paise`):
  - the first tier is `min_members = 1`, the price for a business on its own;
  - each further tier has a higher threshold and a **strictly lower** price;
  - no threshold may exceed `pool_max_members`.
  - The shared rule is `poolTierProblems`. An offer that breaks it gets **400 `tiers_incoherent`**.

**Storage.** Like `quote_options`, tiers are immutable rows. The offer and its tier tables are **service role only**, and the API is their one reader and writer. A provider can withdraw an offer while the pool is open. Withdrawing clears the commitments made to it.

**Sealing.** Offers are sealed:
- a provider never sees another provider's offer or the count committed to it;
- a provider cannot counter.

The buyer sees every offer with the server's all-in figure for each tier (`quoteChargeAmounts` under the offer's GST mode, "₹X + GST = ₹Y"), plus how many members have chosen it so far.

**Why this is not what §8.3 and PRD A.5 refuse.**
- The price schedule is stated by the provider **before** any buyer chooses, and never changes afterwards.
- No buyer asks anyone for a discount.
- No provider sees a competitor's price.

This is the Mart M1 bulk-tier rule (ADR 006) applied to services. Like ADR 020, it adds choices the provider states; it does not add a negotiation.

### 2.5 Commit, then one ordinary quote per member at close

**Before close.** A joined member may commit to one offer, or to none. Committing moves no money.

An offer is *available to a member* only when both hold:
- its provider has not already quoted that member's request directly;
- its provider has not declined that request.

In either case the member keeps the direct route.

**The close** (the same cron; replay-safe):
1. **Pre-checks, for each committed member.** The provider must still be active. The request must be `open` or `quoted` and unexpired. The provider must have no quote on it and must not have declined it. A member who fails is marked `skipped` with a reason.
2. **Claim.** For each member who passes, the SQL function `service_pool_claim(member_id)` claims the request's quote slot through the existing `claim_quote_slot` (the 7-quote cap is enforced as always). It marks the member `claimed` **in the same transaction**, so a crashed close never claims twice. A request that is full is `skipped`.
3. **Tier.** Per offer, the achieved tier is the highest tier whose `min_members` ≤ the number of **claimed** members (shared `achievedTier`). It is persisted on the offer before any quote is written, so a resumed close uses the same price.
4. **Write.** One **ordinary quote** per claimed member, at the achieved tier price.
   - The quote is built through the same `resolveQuoteTerms` / `quoteRowColumns` path as the submit route: services terms, GST mode and validity from the offer.
   - It gets a `submitted` quote event whose payload carries the pool, offer and tier.
   - The member is linked to the quote. A missing fan-out match row is upserted first, under the same rule fan-out uses.
5. **Notify.** Each member hears "your group price from <provider> is ₹X; it is in your quotes". Each provider hears the count and the price. The pool becomes `closed`, and memberships are `released`.

**From here nothing is new.** The buyer pays that quote through the ordinary **Accept & pay**. `finalizeQuoteAcceptance`, the order, escrow, the payout and loss labels work unchanged, because the quote row holds the price the buyer pays. **There is no new checkout branch, order state or money path.**

### 2.6 Who writes quotes

Quotes are written by two paths:
- the provider's submit route;
- the pool close, **on the provider's recorded authorisation**. The offer screen says, before the tap: "When the group closes, AMClub sends this offer as a quote to each business that chose it, at the price for the number that chose you."

Both paths go through `lib/rfq/quote-terms.ts`. CLAUDE.md's S1.1 line is updated to say so.

### 2.7 Data

**Migration 0071 (agent migration, not staged).** It creates:
- `service_pools`;
- `service_pool_members`;
- `service_pool_offers`;
- `service_pool_offer_tiers`;
- `service_pool_events` (append-only);
- the function `service_pool_claim` (EXECUTE for `service_role` only).

It also widens the `ai_decisions_feature_check` with `demand_pool`. RLS is on for every new table and **no client grant** is given: the API reads and writes them all on the admin client after its own authorisation. **No existing table gains a column**, so a database without 0071 fails no query outside the pool surfaces, and those only run with the switch on.

### 2.8 Settings

These are registry keys, so none can be written unregistered:

| Key | Default |
|---|---|
| `pool_min_members` | 3 |
| `pool_max_members` | 20 |
| `pool_form_hours` | 12 |
| `pool_open_hours` | 24 |
| `pool_pay_buffer_hours` | 12 |

## 3. Consequences

- Buyers with a common need can get a volume price with no negotiation, no new state and no new money path. Everything after the close is the ordinary quote → order flow that the rigs already prove.
- **The known risk is honest commitment.**
  - A tier is decided by the members who committed and could be quoted. Some of them may not pay, and the provider then sells fewer jobs at the volume price.
  - The provider sets the tiers knowing this. Their volume price is also only as deep as they choose.
  - The admin pool list shows each closed pool's committed → paid rate. A buyer-discipline rule, like Mart's pool discipline, is a follow-up once there is real data.
- A group needs requests that arrive within about a day of each other. At pilot volume, groups will be rare. That is fine for a dark build; the enablement note must show the density.
- **Web only in v1.** The mobile app reads the same `/api/v1` routes; its screens and a WhatsApp template are follow-ups (`docs/FOLLOWUPS.md`).
- **Rollback:**
  - Turn `agents_enabled.demand_aggregation` off. Detection stops, the surfaces 404, and the cron records a no-op heartbeat.
  - Quotes already written by a close stay ordinary quotes at their stated price.
  - 0071 is additive and can stay.

## 4. Verification

- **Shared tests:** the pool machine, `clusterPoolCandidates`, `poolTierProblems`, `achievedTier` and `planPoolClose`.
- **`scripts/verify-pools.ts`**, run in the money rigs against a second app server with `AGENT_ENABLED=true`:
  - **Inert with the flag off:** 404s, and the cron is a no-op.
  - **Detection:** a pool is proposed from four requests.
  - **Joining:** three joins write `ai_decisions` and open the pool.
  - **Offers:** an incoherent offer gets 400; a non-member cannot commit; commitments are recorded.
  - **Close:** it writes exactly one quote per committed member at the achieved tier. `quote_count` moves by one each. A replayed close writes nothing.
  - **Payment:** a member pays the pool quote through the ordinary checkout, and the order total equals `quoteChargeAmounts` at the tier price.
  - **Other paths:** lapse, withdraw and cancel.
