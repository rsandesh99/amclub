# ADR 019 — Package add-ons: priced extras on one order

**Status:** Accepted 2026-09-23. It follows the approved PRD Experience v3, E12a (N15, "ADR-XA"). It changes money, so it goes through §8.4: it adds a money-rig criterion and ships dark behind `agent_settings.addons_enabled` (default off). It depends on ADR 018 (checkout sessions and orders are server-written only), without which the frozen snapshot below could be rewritten from the client.

## Context

Fiverr's priced extras (survey FV-07) are the clearest take-rate lever we found. Buyers ask for two things: "deliver faster" and "one more revision". Today a package has one price, one delivery time and one revision count. Anything extra is agreed outside the platform, or not at all.

The rules this must keep (CLAUDE.md §2.5 and the E12 common rules):
- **One money path.** `computeOrderAmounts` on the server. Amounts are frozen into the checkout session, and the webhook materialises the order from that session.
- **The webhook is the only truth.** A replay never creates twice.
- **No new order states**, and no repurposed transitions.
- **No negotiation (§8.3).** The provider sets every option before the buyer sees it, and the buyer only picks.

## Decision

1. **`package_addons`** (migration 0065).

   | Column | Rule |
   |---|---|
   | `id`, `package_id` | FK to `packages` |
   | `label_i18n` | English required, ≤ 40 characters per language |
   | `price_paise` | bigint > 0 |
   | `days_delta` | integer −30…30; negative means fast-track |
   | `extra_revisions` | integer 0…5 |
   | `active`, `sort` | |
   | timestamps, `deleted_at` | |

   - At most **3 active add-ons per package**. A trigger enforces it, and so does the shared `packageAddonInputSchema` (Zod).
   - Anyone reads active add-ons of an active package. The provider reads all of their own.
   - No client writes. The partner routes write with the service role after checking ownership.

2. **One charge rule.** Shared `packageCharge` is the ONE function behind the checkout package branch, the new `POST /api/v1/checkout/preview` and the buy-box display:
   - **Subtotal** = package price + Σ add-on prices.
   - **The package's own % discount applies to the package price only.** The buyer was shown "+₹500", so the add-on is charged at ₹500 before GST.
   - **A coupon applies to the whole pre-GST subtotal** (one rule). `evaluateCoupon` sees subtotal − package discount.
   - `computeOrderAmounts` runs **once**, with `pricePaise = subtotal` and `extraDiscountPaise = package discount + coupon`.
   - **With no add-ons it is exactly the pre-ADR call**, byte for byte. A unit test pins this.

3. **Delivery and revisions** come from the same snapshot:
   - `delivery_days` = max(1, package days + Σ `days_delta`);
   - `revision_max` = package revisions + Σ `extra_revisions` (a null package count counts as 0 once any add-on adds revisions).

   Both are frozen on the session like every other order column, so `materialize_order` needs no change.

4. **Snapshot.** `checkout_sessions.addons` and `orders.addons` hold `[{ id, label, pricePaise, daysDelta, extraRevisions }]`, frozen at session creation. The trigger `checkout_sessions_copy_addons` copies it onto the order in the same transaction that links the session to its order (`order_id` set by `materialize_order`). This works with both the current function (0003) and the staged Mart one (0022), so neither is redefined.

5. **Checkout.**
   - The body takes `addonIds[]` (≤ 3, package branch only).
   - The server loads the package's active add-ons and ignores anything else the client sends about them.
   - An id that isn't an active add-on of this package → **409 `addon_changed`**. This covers an add-on removed or deactivated between preview and payment, and any add-on while the switch is off.
   - A resumed session (same idempotency key) with a different add-on set → **409 `addon_changed`**, never the old amount for a new selection. The web client's idempotency key includes the selection.

6. **Invoices.** `generateInvoices` writes the package line (order price − Σ add-ons) and one line per add-on, at the same GST rate. The buyer invoice's `totals.lines` records them, so that line sum − discount + GST = the order total (rig-checked).

7. **Disputes and refunds** settle on the order total. `planDisputeSettlement` is unchanged, and add-ons aren't separable in v1.

8. **Scope.** Packages only (quotes get options in E12b), web buy box and checkout first. Mobile Buy Now sends no `addonIds` and is unchanged.

## Consequences

- One more revenue line per order, with no new state, no new money path and no change to payouts. The provider earns on the whole taxable value at the frozen commission.
- A replayed webhook still creates nothing: the add-ons ride the session, and the trigger only fires when `order_id` is first set.
- The package discount not reaching add-ons is deliberate: the buyer pays exactly the "+₹X" they saw.
- **Rollback:**
  - Set `addons_enabled` off. Checkout then refuses `addonIds` and the buy box shows nothing.
  - Orders already paid keep their snapshot and invoices.
  - Migration 0065 is additive (a table, two nullable jsonb columns and a trigger), so it can stay.
