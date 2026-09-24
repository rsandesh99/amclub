# ADR 028 — A KYC record earns a chip only when it is the claimant's own

**Status:** Accepted 2026-09-24. **Security fix** touching KYC and the payout hold (CLAUDE.md: ADRs for anything touching auth / KYC). Migration **0082** (additive, NOT staged). Found by the architecture and security audit of 2026-09-24 (`docs/audit/2026-09-24-architecture-security-audit.md`, finding **M12**).

## Context

Two trust signals were set from a vendor answer that only proved a number **exists**:

1. **The Udyam chip.** `POST /api/v1/kyc/verify-udyam` set `msme_profiles.udyam_verified` / `provider_profiles.udyam_verified` whenever Surepass returned `success` for the number. Anyone could type a real enterprise's Udyam number and wear its "Udyam verified" chip: providers show it to buyers comparing quotes, buyers show it to providers (`isBuyerVerified`). Any number of accounts could claim the same registration.
2. **The penny drop.** `profile/provider` POST set `provider_bank_accounts.penny_drop_verified` from a recorded `/kyc/verify-bank` success. The bank returns the account holder's name, but nothing compared it with the business, so a provider could route payouts to someone else's account and still clear the `bank_unverified` payout hold.

Both were latent while production ran the KYC stub (the stub never earns either flag) and would go live with the vendor key.

## Decision

1. **Ownership, not existence.** A real (non-stub) vendor record counts only when shared `kycOwnership` (`packages/shared/src/kyc-ownership.ts`) says it is the claimant's own:
   - **ID match.** The vendor returned a GSTIN equal to one of the claimant's own, or a PAN equal to one of theirs (the PAN inside a GST-locked GSTIN, or an admin-reviewed PAN). The Surepass Udyam payload is parsed for `pan` / `gstin` wherever it carries them.
   - **Name match.** Otherwise, the vendor's enterprise name (Udyam) or account-holder name (penny drop) must match a **GST-locked** name after `normaliseBusinessName`. Normalising means upper case, punctuation removed, "M/s" / "Messrs" removed, `&` treated as AND, and trailing legal forms removed: PVT LTD, PRIVATE LIMITED (also when a bank truncates it), (P) LTD, LLP, OPC, & CO, COMPANY. Fillers (AND, THE, OF) are dropped. The match rules are, in order: exact; equal without spaces ("R K" ~ "RK"); initials of the same length with a distinctive word shared ("R K SHARMA" ~ "RAJESH KUMAR SHARMA"); or token overlap of at least **0.8** of the longer name, with at least one distinctive (non-generic) word shared. A name of one or two words must match in full. "SRI SAI TRADERS" never matches "SRI SAI ENTERPRISES".
   - **A contradicting ID loses.** If the vendor returns a PAN / GSTIN and the claimant has one that differs, the result is a mismatch (`id_conflict`) even when the names agree. Two businesses can share a name; they cannot share a PAN.
2. **What "GST-locked" means** (`apps/web/lib/kyc/ownership.ts`). It is the registry legal and trade name from the latest real (`provider = 'surepass'`, non-stub) verified `gstin_verifications` row for **this user** and **the profile's GSTIN**, plus that GSTIN and its PAN. For an admin-approved provider (status `active`), the reviewed `legal_name` is added, together with the values of its approved `provider_verifications` rows of kind `gstin` / `pan`. Nothing the request says counts. The one exception is `verify-bank`, which may name the GSTIN the wizard just verified; that GSTIN still needs the same user's vendor row.
3. **Every attempt carries an outcome** (0082): `udyam_verifications.outcome` and `bank_account_verifications.outcome` ∈ shared `KYC_ATTEMPT_OUTCOMES` = `verified | name_mismatch | not_verified | stub | udyam_already_claimed` (bank: the first four; NULL on the admin route's `admin_override` rows). The decision is stored as `result.match` (outcome, basis, reason, score, rule, the reference name; never an ID).
4. **Udyam** (`/api/v1/kyc/verify-udyam`):
   - A claim held by **another** account is refused **before** the paid vendor call: 409 **`udyam_already_claimed`**, recorded with `provider = 'precheck'`.
   - A vendor "not found" gives `not_verified` (422, as before). The stub gives `stub` (200, `chip: false`, as before).
   - A real record that is not the caller's gives `name_mismatch`: 422 **`udyam_name_mismatch`** (`review: true`, `reason`), no chip.
   - A match gives `verified`: the chip is set (MSME: with the number).
   - The route now refuses delegated agent tokens (`requireNotDelegated`) like the other KYC routes.
5. **One active claim per Udyam number.** A claim is a row with `outcome = 'verified' AND released_at IS NULL`. A unique partial index on `upper(udyam_number)` over those rows is the final arbiter: a race loser gets 23505, which the route records and answers as 409. The holder re-verifying is recorded as a **born-released** verified row, so the original row stays the claim.
6. **Penny drop.**
   - `/kyc/verify-bank` compares the returned holder name with the GST-locked names and records `verified` or `name_mismatch`. It still answers `verified: true` (the account exists), plus `nameMatch`, so the wizard is not blocked. The v3 wizard says payouts stay on hold until the team checks the account.
   - `profile/provider` POST sets `penny_drop_verified` only when that holder name matches the GST-locked name of **the GSTIN submitted there**, and re-records the row's outcome if it differs. An `admin_override` row (the audited admin decision) counts as is.
   - A mismatch leaves the payout hold (`bank_unverified`) in place. Ops clear it with the existing audited `set_bank_verified` override.
7. **Ops review.** The admin verification queue shows a "KYC checks need review" section (`KycOwnershipFlags`, data from `lib/kyc/review.ts`). It lists the last 30 days of `name_mismatch` (Udyam and bank) and `udyam_already_claimed` attempts, each with the vendor name against the name on file. An item drops off once resolved (the bank became verified, or the account now holds the claim).
8. **The stub never earns anything.** It is recorded as `stub` and is never a claim, a chip or a penny drop. `KYC_FAKE=verified` (the verify-trust rig) now also refuses to run on any Vercel deployment (`VERCEL_ENV` set), besides `NODE_ENV=production`.
9. **Grants (ADR 025).** No client writes either table. `udyam_verifications` is `SELECT` for `authenticated` only (RLS: own rows; admin / ops all). `anon` and the default `TRUNCATE` / `REFERENCES` / `TRIGGER` are revoked. `bank_account_verifications` stays service-role only.

## Migration 0082 and existing data

- Legacy rows are backfilled: stub → `stub`, vendor-verified → `verified`, else `not_verified`. Bank rows are backfilled only where `provider IN ('surepass', 'stub')`.
- **Duplicates are resolved before the unique index:**
  - A user's older repeat verifications of one number are released; the newest stays the claim.
  - Across accounts, the account that verified **first** keeps the claim. Every later account's active row becomes `udyam_already_claimed` (released), and that account's `udyam_verified` chip (MSME and provider) is cleared unless it holds another claim.
  - The migration `NOTICE` reports both counts.
  - Production ran the stub, so no vendor-verified rows are expected there. The step exists so the index can never fail on real data.
- Legacy vendor-verified claims were never name-checked. They are kept (grandfathered) as claims; ops can release one (below). Existing `penny_drop_verified` flags are not re-evaluated: production never set one from a vendor, and admin overrides are explicit decisions.

## Consequences

- A chip or a penny drop now needs the GST record to be right first. A provider or buyer without a vendor-verified GSTIN (or, for a provider, admin approval) cannot earn the Udyam chip automatically, and their penny drop waits for ops. This is intended. The queue shows them with the reason `no_reference`.
- **Residual risk.** The chain is only as strong as the GSTIN claim. A provider's GSTIN is reviewed by an admin at approval. A buyer's GSTIN is self-declared, so a buyer who types another business's GSTIN could still borrow its names. The one-claim rule then surfaces the conflict: the real owner gets 409 and lands in the ops queue. A stronger buyer proof (GST-portal OTP or Aadhaar e-KYC) is future work.
- New error codes: 409 `udyam_already_claimed`; 422 `udyam_name_mismatch`. `verify-bank` adds `nameMatch` to its 200 body.
- **Proof:**
  - Shared unit tests: `kyc-ownership.test.ts` covers the normaliser, the match table (same business / different business), the decision (ID match, ID conflict, no reference, no vendor name) and the closed outcome enum.
  - `verify-authz` "M12 KYC ownership", in CI with the stub, covers:
    - the unique index (a second active claim in any case → 23505; a born-released row allowed; the CHECK);
    - the route's pre-check (409 `udyam_already_claimed`, recorded, no chip);
    - the holder not refused;
    - the stub recorded as `stub` for Udyam and bank, with no chip;
    - no client insert, no anon read, and the owner reads their own outcomes.
  - `verify-trust` under `KYC_FAKE=verified` covers the name path end to end: mismatch → 422, a GST-locked name → chip, a second account → 409, and a holder repeat keeping one claim.

## Runbook — releasing a claim

When ops confirm that the account holding a Udyam number is not its owner, release the claim and clear the chip in one transaction (service role / SQL editor):

```sql
UPDATE udyam_verifications SET released_at = now()
 WHERE upper(udyam_number) = upper('<UDYAM-XX-00-0000000>') AND outcome = 'verified' AND released_at IS NULL
 RETURNING user_id;
-- then, for that user_id, unless they hold another claim:
UPDATE msme_profiles SET udyam_verified = false, updated_at = now() WHERE user_id = '<user_id>';
UPDATE provider_profiles SET udyam_verified = false, updated_at = now() WHERE user_id = '<user_id>';
```

The rightful owner can then verify.

## Rollback

- **Code.** Reverting the routes restores "exists = verified". That reopens M12 and is not recommended.
- **Schema.** Dropping `udyam_verifications_one_claim_uidx` restores multi-claim. The `outcome` / `released_at` columns and the review indexes are additive, and old code ignores them, so they can stay.
- **Data.** Rows 0082 moved to `udyam_already_claimed` keep their original vendor result. To restore one, set `outcome = 'verified', released_at = NULL`, but only after dropping the unique index.
