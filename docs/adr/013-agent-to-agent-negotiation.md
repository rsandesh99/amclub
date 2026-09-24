# ADR 013 — Agent-to-agent negotiation (S4.3): options, recommendation, the §8.3 text

**Status: Proposed 2026-09-24. The recommendation is to change nothing now.**
- This ADR closes build step **S4.3**. S4.3 is paperwork plus a pure-function spike, with no product surface (`BUILD_PROMPTS.md`).
- It touches money and the NOT-NOW register (§8.3), so it needs the founder's decision in §8.
- Until the founder picks something other than option A, **no code is built on it**.

## 1. Context

`DESIGN.md` §8.3 pre-rejects two things this topic lands on:
- **"Bidding wars/auctions on RFQs (race-to-bottom destroys provider quality)"**;
- **"custom per-buyer pricing negotiations in V1 (RFQ covers it)"**.

The founder-approved Experience v3 PRD (2026-09-23) goes further. `docs/prd/PRD_EXPERIENCE_V3.md` Appendix A.5 refuses, under §8.3:
- **"AI negotiation"** (Alibaba AI Mode, the compare-tray "AI negotiate");
- **reverse-auction RFQs**;
- **"Request a discount from several suppliers" (Amazon Business), "including the 'capped single-round' variant"**.

§8.6 lists "agent-to-agent negotiation" as out of scope and says negotiation "touches the §8.3 'bidding' exclusion and needs an explicit amendment". `BUILD_PROMPTS.md` S4.3 asks for this ADR, the exact §8.3 text change the founder would approve, and a spike test. Nothing is to be enabled, and there is no schema.

What the product already does about price, all of it without negotiation:

| Mechanism | Where | What it means for negotiation |
|---|---|---|
| Sealed RFQ quotes, capped at 7 | Phase 5 | Providers never see each other's prices. This is the "RFQ covers it" in §8.3. |
| Provider-initiated quote revision, at most 3 submissions | S1.3; `MAX_QUOTE_REVISIONS`; `quotes_revision_range` CHECK | A provider can already lower a price. Only the provider starts it. |
| Munshi drafts inside a code-enforced price band | S2.2; `clampMunshiDraft` | The provider's agent never proposes outside the provider's own history. |
| The no-negotiation clamp | S3.1; `clampProviderMessage` | A drafted provider message with an amount, a percentage or counter-offer wording is refused, in every locale. |
| The Procurement agent never negotiates | S3.1; `PROCUREMENT.md` | "Go with B" produces a link to the ordinary pay page. The agent never changes a price. |
| Fair price ranges | S3.2; `benchmarks.ts` | Both sides see the same range, from paid orders only, past four privacy gates. |
| Loss labels | E7; `quote-loss.ts` | A losing provider learns whether it lost on price or on time, and by how much. |

## 2. Why the question comes up at all

Indian MSME buying culture expects to ask for "thoda kam" (a little less).
- Today a buyer who wants a lower price has two moves: decline the quote, or write in the clarification thread. The clamp blocks counter-offer wording there, by design.
- A provider who would have taken 5 % less loses the job without knowing it was close. The E7 loss labels now show this *after* the fact.
- The measurement to watch is already recorded: among RFQs where the winning quote beat a losing one on price, how often the gap was within 10 %. That is the size of the prize for any option below. This ADR does not assume the number; §7 makes it a precondition.

## 3. Options

### A. Keep §8.3 as it is (status quo)

Price moves only when the provider revises on their own initiative (up to 3 submissions), informed by the fair range and the loss labels.
- **For:**
  - nothing new to police;
  - no race to the bottom;
  - no extra flows, and no information leaks between providers or from provider to buyer.
- **Against:**
  - close-but-lost jobs stay lost;
  - buyers who want to ask for less have no sanctioned way to do it.

### B. Sealed one-round counter ("ask once for a better price")

1. The buyer may name **one target price per quote revision** (a number, never text).
2. The provider's own **pre-set rule** answers it. The rule has two parts, both set by the provider ahead of time: a private floor, and a maximum concession in basis points, capped by the platform.
3. The rule's answer is a *proposal*. The provider taps to send it as an ordinary quote revision, through the existing `PATCH /api/v1/rfq/[id]/quote`.
4. The provider can also ignore it.

Properties, all proven by the spike (§6):
- **Bounded:** never below the floor, never above the quote, never more than the cap.
- **Sealed:**
  - the rule sees one provider's numbers and the buyer's one number;
  - there is no input for another provider's price, so the rule cannot run an auction;
  - providers never see the target or each other.
- **One bit per probe:** a counter's price depends only on the quote and the target. The floor and the cap only decide yes or no.
- **Few probes:** one counter per revision, and a counter consumes a revision. With `MAX_QUOTE_REVISIONS = 3`, a quote can be probed at most twice over its life, so a buyer cannot binary-search a provider's floor.
- **Code, never a model:** integers in paise, deterministic, no text.

For and against:
- **For:**
  - it recovers close-but-lost jobs;
  - it gives the "thoda kam" instinct a bounded, auditable channel;
  - it reuses the revise route and every money path unchanged (the order is still built from the quote row);
  - it is the smallest thing that answers §2.
- **Against:**
  - **the founder refused this exact shape one day before this ADR.** A buyer could name a target on each of up to seven quotes at once; that is "request a discount from several suppliers" in its "capped single-round" variant (PRD A.5). Building B means reversing A.5 as well as amending §8.3;
  - it is price negotiation, so §8.3 must be amended;
  - it adds a provider settings surface (floor and cap);
  - providers may anchor their first quotes higher to leave room, which would push list prices up. The benchmark and the §7 metrics are how that would be seen.

### C. Multi-round agent-to-agent negotiation

The buyer's agent and each provider's agent alternate offers until they converge or time out, each holding its principal's private reservation price.
- **Against (decisive for now):**
  - Floors leak by repeated probing unless rounds are capped, and once capped this collapses into option B.
  - It needs a model in the money loop to "argue", which ADR 008 and §8.6 forbid ("every money/status action requires an explicit user confirmation").
  - Every provider's agent is run by the same platform and fed the same market data. That is a hub-and-spoke price-coordination risk under the Competition Act, and needs counsel before it is even designed.
  - Latency: a request would stay open while agents haggle, against the 72-hour RFQ clock.
- **For:** the most "agentic" story.

### D. Reverse auction on high-value RFQs

Providers see the current best price and undercut it until a deadline. This is word for word the "bidding wars/auctions" §8.3 names, and `BUILD_PROMPTS.md` already parks it under "Tracking only". **Rejected**: it is the race to the bottom that §8.3 exists to prevent.

### E. Standing per-buyer price lists

A provider agrees a rate card with one buyer for repeat work. This is the "custom per-buyer pricing" §8.3 names for V1. It belongs with membership pricing and repeat-order work at V2, not with agents. **Out of scope here.**

## 4. Recommendation

**Option A now.**
- The founder refused the capped single-round variant in PRD A.5 on 2026-09-23. Nothing has happened since that would reopen it.
- The product is pre-pilot. Payments are in simulation (ADR 023), no provider is approved yet, and there are no real paid orders.
- There is no evidence yet that close-but-lost jobs are common, and no provider base whose quoting behaviour could be observed changing.
- §8.3 stays exactly as written.

**Option B is the only option worth revisiting.** Revisit it at the **V1.5→V2 gate** (§8.2), only when all of §7 hold, and only through:
- its own §8.1 mini-PRD with a RICE score;
- the §5 amendment to §8.3;
- a founder reversal of PRD A.5's "capped single-round" refusal.

C, D and E stay rejected for the reasons above.

## 5. The exact text changes (for option B only; not applied)

If and only if the founder later chooses B, `DESIGN.md` §8.3 changes from:

> Bidding wars/auctions on RFQs (race-to-bottom destroys provider quality) · provider chat before any RFQ/order (disintermediation highway) · cash/offline payments (kills escrow trust model) · custom per-buyer pricing negotiations in V1 (RFQ covers it) · social feed/community features · gamification points · video consultations · international providers or multi-currency · dynamic surge pricing · blockchain anything.

to:

> Bidding wars/auctions on RFQs (race-to-bottom destroys provider quality) · provider chat before any RFQ/order (disintermediation highway) · cash/offline payments (kills escrow trust model) · custom per-buyer pricing negotiations in V1 (RFQ covers it; **the one exception is the sealed one-round counter of ADR 013 option B: one numeric target per quote revision, answered only by the provider's own pre-set floor and capped concession, sent only by the provider's tap as an ordinary revision; no provider ever sees another's price or the buyer's target, and no model sets a price**) · social feed/community features · gamification points · video consultations · international providers or multi-currency · dynamic surge pricing · blockchain anything.

The "bidding wars/auctions" clause is **not** touched, and neither is `clampProviderMessage`. Free-text haggling stays refused, and the counter is a structured number in its own flow.

`PRD_EXPERIENCE_V3.md` A.5, third bullet, changes from:

> - "Request a discount from several suppliers" (Amazon Business), including the "capped single-round" variant.

to:

> - "Request a discount from several suppliers" (Amazon Business). The one exception is the sealed one-round counter of ADR 013 option B, accepted on <date> under ADR 013 §7.

The first bullet, "AI negotiation", stays: in option B no model sets or argues a price.

## 6. The spike (`packages/shared/src/spikes/negotiation.ts`)

`sealedCounter(input)` is option B as a pure function. `__tests__/negotiation-spike.test.ts` proves the laws:

| # | Law | Test |
|---|---|---|
| 1 | Bounded (floor ≤ price ≤ quote, concession ≤ cap, integer paise, on the ₹100 grid) | seeded 20,000-input sweep |
| 2 | Sealed (no cross-quote input) | a `@ts-expect-error` on an `otherQuotesPaise` field; a five-provider "bidding war" simulation where each provider moves at most twice, each time within its own cap |
| 3 | One bit (a counter's price ignores the floor and the cap) | the same answer under the loosest and the tightest rule that admit the target |
| 4 | Few probes (at most `MAX_QUOTE_REVISIONS − 1` answers per quote) | an adversarial binary search on the floor is stopped after its first decline; the floor stays uncertain across a wide band |
| 5 | Refuses malformed input rather than guessing | ten malformed shapes |

The spike's scope:
- It is **not exported** from `@amclub/shared`, and a test asserts this.
- It has no caller, no schema, no flag, no `agent_settings` key and no prompt.
- Deleting the two files changes nothing.

Choices it makes that the build would revisit:
- the counter splits the gap, with the provider keeping the odd paisa;
- the ₹100 grid rounds up;
- the platform cap is 15 %.

## 7. Preconditions for ever building option B

All of the following are required:
1. The V1.5→V2 gate (§8.2) has passed, and the founder reverses PRD A.5's "capped single-round" refusal in writing.
2. From at least 90 days of real RFQs, using the E7 loss labels: the share of price-lost quotes whose gap to the winner was within 10 % is material enough to score in a §8.1 RICE. The founder sets the threshold in the mini-PRD.
3. Median first-quote prices are measured (from the benchmark inputs) before launch and watched after it. A rise beyond the fair range is the anchoring failure named in §3 B, and it is the kill criterion.
4. Counsel's note on the Competition Act position of platform-run price rules, even per provider.
5. A new ADR for the build: the floor and cap settings surface, the ledger (`ai_decisions` feature for the provider's tap), and the flag.

## 8. What the founder decides

- [ ] **Accept option A** and keep §8.3 and PRD A.5 unchanged. This is the recommendation, and it matches the PRD A.5 decision of 2026-09-23. S4.3 is then done.
- [ ] Or record the intent to revisit B at the V1.5→V2 gate under §7. §8.3 and A.5 still stay unchanged today.
- C, D and E: rejected; no decision needed.

## 9. Consequences

- The build does not change. `clampProviderMessage` and the Procurement agent keep refusing negotiation.
- Future work that proposes any price negotiation starts from this ADR's §5 text and §7 preconditions, not from a blank page.
