# ADR 002 — Founder approval gate on provider payouts

**Status:** Accepted, 2026-08-23. Touches money (§8.4) — commit `82d1c2e`.

## Context

§3.7 releases a payout automatically after buyer acceptance (or 72h
auto-accept) via a T+2 schedule and the daily payout cron. For pilot launch
the founder requires absolute control: no money reaches a provider until the
delivered work has been personally checked.

Separately, `createTransfer` used to *simulate* when a provider had no
Razorpay Route linked account, marking the payout `paid` (`trf_sim_…`) while
money never moved — an unacceptable state once real rails are live.

## Decision

1. **`PAYOUT_AUTO_RELEASE` flag, default OFF.** With the flag off (the launch
   state), `schedulePayout` creates every payout with status `held`. The §9.2
   holds (open dispute, suspended provider, unverified bank) are unchanged and
   still apply when the flag is on.
2. **Admin release settles immediately.** `POST /api/v1/admin/payouts/[id]`
   moves `held|failed → scheduled` and then runs the transfer for that order
   in the same request — the admin's click is the money-moving moment, not a
   reschedule for tomorrow's cron. Audit-logged as `payout_release`.
3. **Real gateway never simulates.** With a real Razorpay gateway, a missing
   Route linked account makes `createTransfer` throw; `runPayouts` marks that
   payout `failed` (visible in `/admin/payouts`, retryable). Simulation is
   confined to the mock gateway.

## Consequences

- The founder/ops is the payout bottleneck by design; `/admin/payouts` must
  be worked regularly or providers wait on their money.
- Dispute settlement (`resolveDispute`) is unchanged — it is already an
  explicit admin action and uses the same transfer rail.
- Exit: set `PAYOUT_AUTO_RELEASE=true` in Vercel to restore the §3.7
  automatic flow — no code change. Recommended once provider trust is
  established during the pilot.
- Verified in production: `verify-money-loop.ts` (gate-aware) proves payouts
  are born `held` and that the live payout cron leaves held rows untouched.

## Note (2026-09-20, agent programme S1.4) — recommendation only; gate unchanged

The Payout-Evidence agent (`docs/agents/PAYOUT_DOSSIER.md`) assembles a
dossier for every payout born `held` and RECOMMENDS approve/hold from
deterministic checks + vision findings. It changes nothing above: payouts are
still born held, `PAYOUT_AUTO_RELEASE` semantics are untouched, and the only
money-moving moment is still the founder's tap on
`POST /api/v1/admin/payouts/[id]` (which now optionally closes the dossier and
records one `ai_decisions` row). Hold does nothing — the payout simply stays
held. No agent tool wraps the release route; a delegated token is refused there.
