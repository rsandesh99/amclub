# Route onboarding — getting a provider payout-ready

**Owner:** ops/founder · **Status:** manual procedure (Phase 3d, 2026-08-28) · **API automation:** scoped follow-up at the end.

A provider can be paid only when **both** facts are true on `provider_bank_accounts`:

| Fact | Column | Set by |
|---|---|---|
| Razorpay Route linked account | `razorpay_route_account_id` (`acc_…`) | Admin → provider detail → *Save Route account* (the `set_route_account` action, audit-logged) |
| Bank account verified | `penny_drop_verified` | `/kyc/verify-bank` with a real KYC vendor, **or** Admin → *Mark bank verified (manual)* — reason required, recorded as `bank_account_verifications.provider = 'admin_override'` |

The admin shows this as **Payout readiness** on the providers list (filterable), the provider detail page, and on every held/scheduled/failed payout. A payout released for a provider who is not ready **fails** (`route_account_missing` in `lib/payments/razorpay.ts`) and lands in `/admin/payouts` as *failed* — readiness is meant to be fixed *before* that tap.

---

## 1. Create the Route linked account (Razorpay dashboard)

Prerequisite: **Route is activated on the live Razorpay account** (Dashboard → Route → Activate; Razorpay approves it — see the cutover checklist below).

1. Dashboard → **Route → Linked Accounts → Add Linked Account**.
2. Choose **Business type** (Individual / Proprietorship / Partnership / Private Limited — match what the provider told us at onboarding).
3. Enter the provider's **legal name**, **contact email + phone** (use the details on their AMClub provider profile).
4. Enter **bank details** exactly as on file: account holder name, account number, IFSC. These must match `provider_bank_accounts` (we can show holder + IFSC + last-4 in admin; never share the full number over chat).
5. Upload the **KYC documents** Razorpay asks for by business type — typically: PAN of the entity/individual, a cancelled cheque or bank statement header, and a business proof (GST certificate / Udyam / CoI). Use the documents the provider uploaded during onboarding (`provider_verifications`).
6. Submit. Razorpay reviews the linked account (usually same/next business day). When approved, the account shows **Activated** and its id appears at the top of the linked-account page in the form **`acc_XXXXXXXXXXXXXX`**. Copy that id.

## 2. Record the id in AMClub admin

1. `/admin/providers` → find the provider (use the **Payout readiness** filter *Missing Route account*).
2. Open the provider → **Payout readiness** block → paste the `acc_…` id in *Linked account id*, add an optional note (e.g. "linked in RZP dashboard, 28 Aug"), click **Save Route account**.
   - The input only accepts `acc_` + 6+ alphanumerics; anything else is rejected client-side and by the API (422).
   - The action writes `audit_logs` (`provider_set_route_account`, before/after).

## 3. Verify the bank account (penny drop)

- **With a KYC vendor provisioned (`KYC_API_KEY`)**: the provider's onboarding wizard already ran `/kyc/verify-bank`; `penny_drop_verified` is set server-side from that result. Nothing to do.
- **Until the vendor is live (today):** confirm the account manually — ask the provider for a cancelled cheque / passbook image, check holder name + IFSC + last-4 against admin, then **Mark bank verified (manual)** with a reason that says what you checked. This is deliberately audited so a manual clearance is never confused with a vendor result.

## When this work is triggered — at approval, by us (option ii, decided 2026-08-28)

Approving a provider never waits on Razorpay paperwork; the provider becomes quotable immediately. In exchange, the **approval itself creates the ops task**:

- the approve action returns the provider's readiness and the admin sees a warning toast ("Approved. Payouts will HOLD until you link…");
- the admin dashboard tile **Payout-ready providers** counts every active provider who is not ready and links to `/admin/providers?status=active&readiness=unready` — that list is the worklist, filled the moment you approve;
- the provider sees a banner on their dashboard and earnings page saying our team is completing the setup and that it was added to our checklist at approval.

That banner is a promise made in our name: **work the tile the same day you approve**, so it is true.

## 4. Confirm readiness

Provider detail should now show **Ready to pay**. Held payouts for that provider lose their readiness badge on `/admin/payouts`; release them from there when the delivered work has been checked (`PAYOUT_AUTO_RELEASE` stays off).

---

## Live-cutover checklist items (add to ADR-003's procedure)

- [ ] **Route activation approved on the live Razorpay account** — without it, linked accounts cannot be created and every real payout fails.
- [ ] **KYC vendor provisioned (`KYC_API_KEY`)** — until then every genuine provider is `bank_unverified` and clearing them is a manual, audited override; the override must not be the norm at real-money volume.
- [ ] At least one provider fully **Ready to pay** and one test transfer settled before the first real order.

## Follow-up (scoped, for the incoming developer): API-automated linked accounts

Not built in this pass — keep the manual path as the fallback.

- **What:** call Razorpay's Linked Account APIs from the admin (`accounts.create` → `stakeholders.create` → `products.request` for Route → upload documents) at the moment the admin approves a provider, and store the returned `acc_…` via the existing `set_route_account` path so audit/readiness stay unchanged.
- **Inputs we already hold:** legal name, contact, bank holder/IFSC/encrypted account number (`decryptColumn` server-side only), uploaded KYC documents in the `kyc-documents` bucket.
- **Constraints:** additive only; the Route transfer path in `lib/payments/payout.ts` stays the only money path; failures must surface as *not ready*, never as a fake `acc_`.
- **Acceptance:** admin approve → linked account created → readiness flips to *Ready* without a dashboard visit; `verify-authz` covers admin-only + audit; a kill-test proves a rejected KYC leaves readiness unchanged.
- **Estimate:** ~2–3 days including Razorpay test-mode Route sandboxing.
