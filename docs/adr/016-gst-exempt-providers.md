# ADR 016 — GST-exempt providers (the PAN path)

**Status:** **Proposed**. Nothing is built. Blocked on founder decision **D3** and a CA's answers to the questions under "E-commerce operator obligations" below.

This is PRD Experience v3 ADR-XD (E10, FR-10.5, N27b). It touches money, invoices and onboarding, so it is decided under §8.4 before any code.

Numbering: 011–013 are reserved by `BUILD_PROMPTS.md`, 014 is dispute settlement safety and 015 is GST-inclusive quotes.

## Context

Many small CA, CS and consultant offices have turnover under the ₹20 lakh GST registration threshold and hold no GSTIN. Today they cannot join: the provider wizard requires a verified GSTIN, and every money path assumes the provider charges GST.

- `computeOrderAmounts` always adds `DEFAULT_GST_BPS` (18 %) on top of the taxable price.
- `generateInvoices` issues a tax invoice for the provider's service.
- The buyer-facing display shows "+ 18 % GST" and, for GSTIN holders, an ITC line.

The E10 onboarding v3 wizard (shipped dark) keeps the GSTIN mandatory. The PRD's "I don't have a GSTIN" link on step 2 is **not rendered** until this ADR is Accepted.

## Proposed decision

1. **Onboarding.**
   - Step 2 gets the link "I don't have a GSTIN (turnover under ₹20 lakh)".
   - The link leads to PAN verification (the KYC vendor's PAN lookup) and an exemption declaration. The declaration text comes from counsel.
   - The provider gets `provider_profiles.gst_registered = false` and `pan_verified_at`, both in a new migration.
   - The declaration is renewed annually. The provider sees a prompt to add their GSTIN once they register.
   - Behind `pan_path_enabled` (agent_settings, default off).
2. **Money.**
   - `computeOrderAmounts` gains an explicit `gstApplicable` input (default `true`). With `false`: `gstPaise = 0` and `total = taxable`. Commission is still on taxable.
   - Checkout, the order row, payout and refund read the provider's `gst_registered` at checkout time and freeze it on the order (`orders.gst_applicable`). Display, charge and payout therefore agree for the life of the order.
   - `verify-money-loop` gains a criterion: a PAN-path order charges `total = taxable`, pays out `taxable − commission`, and a full refund returns `total`.
3. **Invoices.**
   - The provider's service invoice becomes a **bill of supply** (no GST lines).
   - AMClub's commission invoice to the provider still carries GST: AMClub is registered.
4. **Display.** Cards, the package page and checkout say "No GST charged" and hide the ITC line. `priceDisplay` returns `gstBps: 0` and `itcPaise: null` for such packages.
5. **Scope.** Services with a statutory credential category only (CA, CS, CMA, advocate, GST practitioner). Mart sellers always need a GSTIN; this is unchanged.

## E-commerce operator obligations (open; a CA must answer)

- **TCS under CGST §52.** Does AMClub collect TCS on supplies by unregistered providers? Registration is compulsory for suppliers through an ECO under §24(ix). The notified exemption for services suppliers under the threshold must be confirmed.
- **§9(5).** Is any of these services notified so that AMClub pays the tax?
- **Returns.** What changes in GSTR-8 when the supplier has no GSTIN?

If the CA's answer is that providers selling through an ECO must register regardless of turnover, this ADR is **Rejected**. The wizard then keeps the GSTIN mandatory, with a help line pointing to GST registration.

## Consequences

- Order rows gain one frozen column. Every money path reads it; none recomputes it from the provider's current flag.
- Existing orders and all GST-registered providers are unaffected (`gstApplicable` defaults to `true`).
- Rollback: turn `pan_path_enabled` off. Already-placed PAN-path orders keep their frozen `gst_applicable = false` and settle as placed.
