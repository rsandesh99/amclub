import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { addonIdsSchema, addonSelectionKey, bundlePlan, bundlePlanSnapshot, couponBasePaise, couponClaimHeld, isValidGstin, packageCharge, quoteChargeAmounts, resolveAddonSelection, type AddonSnapshot, type BundleMilestoneRow, type BundlePlanSnapshot, type OrderAmounts, type PackageAddonRow } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { RFQ_GOODS_COLS, QUOTE_GOODS_COLS, isGoodsRow } from '@/lib/mart/staged-columns'
import { getPaymentGateway } from '@/lib/payments'
import { checkoutTimeoutSeconds, MIN_RESUME_SECONDS, paymentsAvailable, PAYMENTS_UNAVAILABLE } from '@/lib/payments/simulation'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { COUPON_ERROR_KEY, couponClaimRefusalKey, evaluateCoupon } from '@/lib/coupons/apply'
import { buyerRedemptions, claimCouponForSession } from '@/lib/coupons/redeem'
import { COUPONS_ENABLED } from '@/lib/flags'
import { createAdminClient } from '@/lib/supabase/server'
import { prepareGoodsQuoteCheckout, type GoodsQuotePrep } from '@/lib/mart/goods-rfq'
import { searchAttributionSchema } from '@amclub/shared'
import { storeCheckoutAttribution } from '@/lib/search/attribution'
import { activeAddonsFor, addonsOn } from '@/lib/addons'
import { optionForCheckout, quoteOptionsOn } from '@/lib/rfq/quote-options'
import { offeredMilestones } from '@/lib/bundles'

const bodySchema = z
  .object({
    packageId: z.string().uuid().optional(),
    quoteId: z.string().uuid().optional(),
    couponCode: z.string().max(50).optional(),
    gstInvoice: z
      .object({
        gstin: z.string().optional(),
        businessName: z.string().optional(),
        address: z.string().optional(),
      })
      .optional(),
    // Client-generated; dedupes a double-submit into one checkout session + order.
    idempotencyKey: z.string().uuid(),
    // E15 F5 — the search that led here; stored best-effort, never part of the charge.
    attribution: searchAttributionSchema.optional(),
    // E12a / ADR 019 — the chosen add-ons (ids only; the server prices them).
    addonIds: addonIdsSchema.optional(),
    // E12b / ADR 020 — the quote option the buyer picked (absent = Standard, the quote itself).
    optionId: z.string().uuid().optional(),
  })
  // Exactly one source — package (Buy Now) OR quote (accepted RFQ quote).
  .refine((d) => !!d.packageId !== !!d.quoteId, {
    message: 'Provide exactly one of packageId or quoteId',
  })
  .refine((d) => !d.addonIds?.length || !!d.packageId, { message: 'Add-ons apply to packages only' })
  .refine((d) => !d.optionId || !!d.quoteId, { message: 'Options apply to quotes only' })

/**
 * Stable machine codes on every error body (`{ error, code }`). Clients map the
 * code to a translated message and never render `error` (kept for API callers
 * that already read it, e.g. mobile).
 */
type CheckoutErrorCode =
  | 'unauthorized'
  | 'gstin_invalid'
  | 'profile_incomplete'
  | 'account_suspended'
  | 'package_unavailable'
  | 'provider_paused'
  | 'quote_not_found'
  | 'not_your_rfq'
  | 'quote_unavailable'
  | 'rfq_closed'
  | 'rfq_checkout_in_progress'
  | 'rfq_already_paid'
  | 'checkout_failed'
  | 'goods_quote_unavailable'
  | 'addon_changed'
  | 'option_not_found'
  | 'payments_unavailable'
  | 'checkout_expired'
  | 'coupon_unavailable'

function fail(status: number, code: CheckoutErrorCode, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, code, ...(extra ?? {}) }, { status })
}

interface SessionRow {
  id: string
  razorpay_order_id: string | null
  total_paise: number
  status: string
  order_id: string | null
  expires_at: string | null
}
const SESSION_COLS = 'id, razorpay_order_id, total_paise, status, order_id, expires_at'
/** A session whose payment was captured (materialize_order claimed it). */
const isPaidSession = (s: SessionRow) => !!s.order_id || s.status === 'materializing' || s.status === 'materialized'

/**
 * Resume an existing session (same idempotency key, or a live session for the
 * SAME quote). Never mints a second Razorpay order; once the session is paid
 * the client is sent to the order instead of re-opening the payment sheet.
 * ADR 027 (audit M21): an unpaid session that has expired (or has less than a
 * minute left) is never resumed — its frozen price, quote or coupon lapsed; the
 * client starts a fresh checkout (409 `checkout_expired`). A live one carries
 * the Razorpay Checkout `timeout` so the sheet closes when the session does.
 */
function resumeResponse(s: SessionRow) {
  if (isPaidSession(s)) {
    return NextResponse.json({
      checkoutSessionId: s.id,
      razorpayOrderId: s.razorpay_order_id,
      amountPaise: Number(s.total_paise),
      orderId: s.order_id,
      alreadyPaid: true,
      idempotent: true,
    })
  }
  const timeout = checkoutTimeoutSeconds(s.expires_at)
  if (s.status !== 'created' || (timeout !== null && timeout < MIN_RESUME_SECONDS)) {
    return fail(409, 'checkout_expired', 'This checkout has expired; start again for the current price', { retryAfter: s.expires_at })
  }
  return NextResponse.json({
    checkoutSessionId: s.id,
    razorpayOrderId: s.razorpay_order_id,
    amountPaise: Number(s.total_paise),
    keyId: process.env['NEXT_PUBLIC_RAZORPAY_KEY_ID'] ?? '',
    idempotent: true,
    // The resume path must say whether to simulate, or a stable client key
    // would open the Razorpay sheet on a simulated order id.
    simulated: !getPaymentGateway().isReal,
    ...(timeout !== null ? { checkoutTimeoutSeconds: timeout } : {}),
  })
}

/** Common frozen-session shape produced by either the package or quote branch. */
interface Prep {
  providerId: string
  source: 'package' | 'quote'
  packageId: string | null
  quoteId: string | null
  title: string
  scopeSnapshot: Record<string, unknown>
  deliveryDays: number
  revisionMax: number | null
  amounts: OrderAmounts
  /** E12a — the frozen add-on snapshot (package branch only; empty = none). */
  addons: AddonSnapshot
  /** E12b — the quote option the session is frozen on (quote branch; null = Standard). */
  quoteOptionId?: string | null
  /** E12c — the frozen per-milestone plan (a bundle package; null = a single order). */
  bundlePlan?: BundlePlanSnapshot | null
}

export async function POST(request: NextRequest) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return fail(401, 'unauthorized', 'Unauthorized')
  const scope = await requireToolScope('place_order')
  if (scope) return scope
  // ADR 023: no simulated (free) payments on the production deployment.
  if (!paymentsAvailable(getPaymentGateway().isReal)) return fail(503, PAYMENTS_UNAVAILABLE, 'Payments are not available right now')

  // Per-user request cap (idempotencyKey already prevents double-charge).
  const rl = await enforce(limiters.checkout, `checkout:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten(), code: 'invalid_body' }, { status: 422 })
  const { packageId, quoteId, idempotencyKey } = parsed.data
  const addonIds = parsed.data.addonIds ?? []
  // GSTIN typed at checkout: normalised and checksum-validated HERE — the
  // invoice (lib/invoices/generate.ts) prefers it over the profile GSTIN, so
  // the server is the authority on what gets frozen into the session.
  let gstInvoice = parsed.data.gstInvoice
  if (gstInvoice) {
    const gstin = gstInvoice.gstin?.trim().toUpperCase() || undefined
    if (gstin && !isValidGstin(gstin)) return fail(422, 'gstin_invalid', 'GSTIN is not valid')
    const businessName = gstInvoice.businessName?.trim() || undefined
    const address = gstInvoice.address?.trim() || undefined
    gstInvoice = gstin || businessName || address
      ? { ...(gstin ? { gstin } : {}), ...(businessName ? { businessName } : {}), ...(address ? { address } : {}) }
      : undefined
  }
  // Coupons are flag-gated (default OFF). When OFF, any client-supplied code is
  // ignored and the coupon branch is skipped entirely — one less branch in the
  // money math. Codes are stored upper-cased, so normalise before lookup.
  const couponCode = COUPONS_ENABLED ? parsed.data.couponCode?.trim().toUpperCase() || undefined : undefined

  // Idempotent: a repeat with the same key returns the existing session/order.
  const { data: existing } = await supabase
    .from('checkout_sessions')
    .select(SESSION_COLS)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (existing?.razorpay_order_id) {
    // E12a — a resumed session never answers a different add-on selection
    // (the web client keys its idempotency on the selection).
    if (addonIds.length || (await addonsOn(await createAdminClient()))) {
      const { data: frozen } = await supabase.from('checkout_sessions').select('addons').eq('id', existing.id).maybeSingle()
      const had = ((frozen?.addons ?? []) as AddonSnapshot).map((a) => a.id)
      if (addonSelectionKey(had) !== addonSelectionKey(addonIds)) return fail(409, 'addon_changed', 'Your add-ons changed; review the total and pay again')
    }
    return resumeResponse(existing as SessionRow)
  }

  // Buyer's MSME profile (RLS: owner read).
  const { data: msme } = await supabase.from('msme_profiles').select('id, deleted_at').eq('user_id', userId).maybeSingle()
  if (!msme) return fail(403, 'profile_incomplete', 'Complete your business profile first')
  if (msme.deleted_at) return fail(403, 'account_suspended', 'Your buyer account is suspended')

  /* eslint-disable @typescript-eslint/no-explicit-any */
  let goodsPrep: GoodsQuotePrep | null = null
  let prep: Prep
  // Audit M10 — the code frozen on the session only when its discount applied
  // (an unusable code no longer leaves a phantom redemption behind).
  let appliedCouponCode: string | null = null

  if (packageId) {
    const { data: pkg } = await supabase
      .from('packages')
      .select(
        'id, provider_id, category_id, title_i18n, scope_included, scope_excluded, deliverables, requirements_template, price_paise, discount_bps, member_extra_discount_bps, delivery_days, revision_count, status, provider:provider_profiles!inner(id, status, capacity_paused), category:categories(commission_bps)',
      )
      .eq('id', packageId)
      .eq('status', 'active')
      .maybeSingle()

    const p = pkg as any
    if (!p || p.provider?.status !== 'active') {
      return fail(404, 'package_unavailable', 'Package not available')
    }
    // Provider "pause capacity" promises buyers can't order while paused — the
    // package Buy Now honours it. (An already-submitted QUOTE may still be
    // accepted: the provider chose to quote while available.)
    if (p.provider?.capacity_paused) {
      return fail(409, 'provider_paused', 'This provider is not taking new orders right now')
    }
    const commissionBps: number = p.category?.commission_bps ?? 1000

    // E12a / ADR 019 — the chosen add-ons, re-read from the package's ACTIVE
    // add-ons (client prices, if any were sent, are never read). An id that is
    // not one of them — removed since the preview, another package's, or the
    // switch is off — is refused, never silently dropped.
    // E12c / ADR 021 — a package with milestones (switch on) sells as ONE payment for N child orders.
    const milestones: BundleMilestoneRow[] = await offeredMilestones(await createAdminClient(), p.id)
    if (milestones.length && addonIds.length) return fail(409, 'addon_changed', 'Add-ons are not offered on plans')

    let addonRows: PackageAddonRow[] = []
    if (addonIds.length) {
      const admin = await createAdminClient()
      const sel = (await addonsOn(admin)) ? resolveAddonSelection(await activeAddonsFor(admin, p.id), addonIds) : ({ ok: false } as const)
      if (!sel.ok) return fail(409, 'addon_changed', 'An add-on changed; review the total and pay again')
      addonRows = sel.rows
    }

    let extraDiscountPaise = 0
    if (couponCode) {
      // Audit M10 — coupons are not client-readable; the lookup is the service role's.
      const couponDb = await createAdminClient()
      const { data: coupon } = await couponDb.from('coupons').select('*').eq('code', couponCode).maybeSingle()
      // The coupon applies to the whole pre-GST subtotal (package after its discount + add-ons).
      const taxableBeforeCoupon = couponBasePaise({ pricePaise: Number(p.price_paise), discountBps: p.discount_bps, addons: addonRows })
      const uses = coupon?.per_buyer_limit != null ? await buyerRedemptions(couponDb, coupon.id as string, msme.id) : 0
      const ev = evaluateCoupon(coupon, taxableBeforeCoupon, p.category_id, { buyerRedemptions: uses })
      // A coupon that has run out (in total, or for this buyer) is refused, never
      // silently dropped: the buyer was shown its discount. Other unusable codes
      // are ignored as before (the total never included them).
      if (ev.error === 'usage_exceeded' || ev.error === 'per_buyer_exceeded') {
        return fail(409, 'coupon_unavailable', 'This coupon can no longer be used on this order', { couponError: COUPON_ERROR_KEY[ev.error] })
      }
      extraDiscountPaise = ev.discountPaise
      if (!ev.error && ev.discountPaise > 0) appliedCouponCode = couponCode
    }
    // ONE rule (shared packageCharge): with no add-ons it is exactly computeOrderAmounts as before.
    const charge = packageCharge({
      pricePaise: Number(p.price_paise),
      discountBps: p.discount_bps,
      commissionBps,
      deliveryDays: p.delivery_days,
      revisionCount: p.revision_count ?? null,
      addons: addonRows,
      couponDiscountPaise: extraDiscountPaise,
    })
    // The split is computed ONCE here (every column sums exactly to the whole) and frozen on the session;
    // the materialisation trigger copies it, never recomputes.
    const plan = milestones.length ? bundlePlan(charge.amounts, milestones) : null

    prep = {
      providerId: p.provider_id,
      source: 'package',
      packageId: p.id,
      quoteId: null,
      title: p.title_i18n?.en ?? 'Service order',
      scopeSnapshot: {
        title: p.title_i18n,
        scopeIncluded: p.scope_included ?? [],
        scopeExcluded: p.scope_excluded ?? [],
        deliverables: p.deliverables ?? [],
        requirementsTemplate: p.requirements_template ?? null,
      },
      deliveryDays: plan ? plan[0]!.deliveryDays : charge.deliveryDays,
      revisionMax: charge.revisionMax,
      amounts: charge.amounts,
      addons: charge.addons,
      bundlePlan: plan ? bundlePlanSnapshot(plan) : null,
    }
  } else {
    // Quote branch — accepting a submitted quote on the buyer's own RFQ.
    const { data: q } = await supabase
      .from('quotes')
      .select(
        'id, status, provider_id, price_paise, gst_included, delivery_days, scope, revision' + QUOTE_GOODS_COLS + ', rfq:rfqs!inner(id, msme_id, category_id, title, status, details' + RFQ_GOODS_COLS + ')',
      )
      .eq('id', quoteId!)
      .maybeSingle()
    const quote = q as any
    const rfq = quote?.rfq
    if (!quote || !rfq) return fail(404, 'quote_not_found', 'Quote not found')
    if (rfq.msme_id !== msme.id) return fail(403, 'not_your_rfq', 'Not your RFQ')
    if (quote.status !== 'submitted') return fail(409, 'quote_unavailable', 'Quote no longer available')
    if (!(rfq.status === 'open' || rfq.status === 'quoted')) {
      return fail(409, 'rfq_closed', 'This request is closed')
    }

    // P0-5 — ONE checkout per RFQ. A paid session on any quote of this RFQ
    // closes it; a live (unexpired) unpaid session on ANOTHER quote blocks a
    // second payment until it expires; a live session on THIS quote is
    // resumed (same Razorpay order) instead of minting a second one. The
    // buyer's ownership is established above; the admin read only makes sure
    // no sibling session is hidden by RLS. finalizeQuoteAcceptance refunds a
    // duplicate that still slips through a concurrent race.
    {
      const admin = await createAdminClient()
      const { data: siblings } = await admin.from('quotes').select('id').eq('rfq_id', rfq.id)
      const siblingIds = ((siblings ?? []) as { id: string }[]).map((s) => s.id)
      if (siblingIds.length > 0) {
        const { data: sessions } = await admin
          .from('checkout_sessions')
          .select(SESSION_COLS + ', quote_id, created_at')
          .in('quote_id', siblingIds)
          .in('status', ['created', 'materializing', 'materialized'])
          .order('created_at', { ascending: false })
        const rows = (sessions ?? []) as unknown as (SessionRow & { quote_id: string })[]
        const paid = rows.find(isPaidSession)
        if (paid) {
          if (paid.quote_id === quote.id) return resumeResponse(paid)
          return fail(409, 'rfq_already_paid', 'A quote on this request has already been paid for', { orderId: paid.order_id })
        }
        const now = Date.now()
        const live = rows.filter((r) => r.razorpay_order_id && (!r.expires_at || new Date(r.expires_at).getTime() > now))
        const same = live.find((r) => r.quote_id === quote.id)
        if (same) {
          // E12b — a live session on ANOTHER option of this quote is another payment in flight: the same rule as another quote.
          if (parsed.data.optionId || (await quoteOptionsOn(admin))) {
            const { data: so } = await admin.from('checkout_sessions').select('quote_option_id').eq('id', same.id).maybeSingle()
            if (((so as { quote_option_id?: string | null } | null)?.quote_option_id ?? null) !== (parsed.data.optionId ?? null)) {
              return fail(409, 'rfq_checkout_in_progress', 'A payment for another option of this quote is in progress', { retryAfter: same.expires_at })
            }
          }
          return resumeResponse(same)
        }
        const other = live.find((r) => r.quote_id !== quote.id)
        if (other) {
          return fail(409, 'rfq_checkout_in_progress', 'A payment for another quote on this request is in progress', { retryAfter: other.expires_at })
        }
      }
    }

    if (isGoodsRow(rfq) && parsed.data.optionId) return fail(404, 'option_not_found', 'Goods quotes have no options')
    if (isGoodsRow(rfq)) {
      // AMC Mart M2 — an accepted GOODS quote becomes an ordinary goods order:
      // one line at the quoted unit price, the buyer's delivery snapshot from
      // the request, commission from the Mart category. Same session →
      // webhook → materialize_order → goods workspace → release gate → payout.
      const g = await prepareGoodsQuoteCheckout(await createAdminClient(), quote)
      if (!g.ok) return fail(g.status, 'goods_quote_unavailable', g.error, { reason: g.error })
      goodsPrep = g.prep
      prep = {
        providerId: quote.provider_id,
        source: 'quote',
        packageId: null,
        quoteId: quote.id,
        title: g.prep.title,
        scopeSnapshot: { kind: 'goods', title: { en: rfq.title, hi: rfq.title }, scope: quote.scope, rfq_id: rfq.id, categories: [rfq.mart_category_slug], seller_name: g.prep.sellerName },
        deliveryDays: quote.delivery_days,
        revisionMax: null,
        amounts: g.prep.amounts as unknown as OrderAmounts,
        addons: [],
      }
    } else {
    const { data: cat } = await supabase.from('categories').select('commission_bps').eq('id', rfq.category_id).maybeSingle()
    const commissionBps: number = cat?.commission_bps ?? 1000
    // E12b / ADR 020 — a picked option must be THIS quote's, at its current revision, with the switch on;
    // its price and days replace the Standard ones (ADR-015 per option: the quote's gst_included covers all).
    let option: { id: string; pricePaise: number; deliveryDays: number } | null = null
    if (parsed.data.optionId) {
      const admin = await createAdminClient()
      option = (await quoteOptionsOn(admin)) ? await optionForCheckout(admin, quote.id, parsed.data.optionId, Number(quote.revision ?? 1)) : null
      if (!option) return fail(404, 'option_not_found', 'That option is not on this quote')
    }

    prep = {
      providerId: quote.provider_id,
      source: 'quote',
      packageId: null,
      quoteId: quote.id,
      title: rfq.title,
      scopeSnapshot: {
        title: { en: rfq.title, hi: rfq.title },
        scope: quote.scope,
        rfqDetails: rfq.details ?? null,
        deliverables: [],
      },
      deliveryDays: option?.deliveryDays ?? quote.delivery_days,
      revisionMax: null,
      quoteOptionId: option?.id ?? null,
      // ADR-015 — a price the provider marked "GST included" is what the buyer
      // pays: GST is carved out of it, never added on top. Excluded or unstated
      // (the confirm sheet says GST is applied at checkout) adds it as before.
      // ADR-017 — the ONE shared rule (quoteChargeAmounts); compare and the provider preview use it too.
      amounts: quoteChargeAmounts({ pricePaise: option?.pricePaise ?? Number(quote.price_paise), gstIncluded: quote.gst_included ?? null, commissionBps }),
      addons: [],
    }
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const { amounts } = prep

  // Create the checkout session (frozen). ON CONFLICT guards a racing double-submit.
  // ADR 018 — sessions are server-written only: the buyer is authorised above
  // (their own msme profile, their own RFQ), and clients hold no write grant on
  // checkout_sessions, so nothing frozen here can be rewritten from the client.
  const writer = await createAdminClient()
  const { data: session, error: insErr } = await writer
    .from('checkout_sessions')
    .upsert(
      {
        msme_id: msme.id,
        provider_id: prep.providerId,
        source: prep.source,
        package_id: prep.packageId,
        quote_id: prep.quoteId,
        title: prep.title,
        scope_snapshot: prep.scopeSnapshot,
        price_paise: amounts.pricePaise,
        discount_paise: amounts.discountPaise,
        gst_paise: amounts.gstPaise,
        total_paise: amounts.totalPaise,
        commission_bps: amounts.commissionBps,
        commission_paise: amounts.commissionPaise,
        provider_earning_paise: amounts.providerEarningPaise,
        delivery_days: prep.deliveryDays,
        revision_max: prep.revisionMax,
        coupon_code: appliedCouponCode,
        gst_invoice: gstInvoice ?? null,
        // Goods-quote sessions carry the goods columns; every other session
        // leaves them at their defaults exactly as before.
        ...(goodsPrep ? { kind: 'goods', line_items: goodsPrep.lineItems, delivery_snapshot: goodsPrep.delivery } : {}),
        // E12a — only a session with add-ons names the column (0065), so checkout is unchanged before it.
        ...(prep.addons.length ? { addons: prep.addons } : {}),
        // E12b — only an option session names the column (0066).
        ...(prep.quoteOptionId ? { quote_option_id: prep.quoteOptionId } : {}),
        // E12c — only a bundle session names the column (0067).
        ...(prep.bundlePlan ? { bundle_plan: prep.bundlePlan } : {}),
        idempotency_key: idempotencyKey,
        status: 'created',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id, total_paise, expires_at')
    .maybeSingle()

  // ignoreDuplicates returns no row when this key already has a session (a
  // racing double-submit, or a retry after the gateway call below failed).
  // Re-read it so the SAME frozen session is bound — never a second one.
  let bound = (session as { id: string; total_paise: number; expires_at: string | null } | null) ?? null
  const reRead = !bound
  if (!bound && !insErr) {
    const { data: again } = await supabase.from('checkout_sessions').select(SESSION_COLS).eq('idempotency_key', idempotencyKey).maybeSingle()
    if (again?.razorpay_order_id) return resumeResponse(again as SessionRow)
    bound = again ? { id: again.id as string, total_paise: Number(again.total_paise), expires_at: (again.expires_at as string | null) ?? null } : null
  }
  if (insErr || !bound) {
    console.error('[checkout] session insert', insErr)
    return fail(500, 'checkout_failed', 'Checkout failed')
  }
  // Audit M10 / ADR 027 — a session that applied a coupon holds one of its uses
  // BEFORE any payment opens: claim_coupon_for_session decides under the coupon's
  // row lock, so two buyers at the last use get one claim and one 409. A re-read
  // session (a racing double-submit) is claimed too: the claim is idempotent.
  if (appliedCouponCode || reRead) {
    const claim = await claimCouponForSession(writer, bound.id)
    if (!claim || !(couponClaimHeld(claim) || claim === 'no_coupon')) {
      return fail(409, 'coupon_unavailable', 'This coupon can no longer be used on this order', { couponError: couponClaimRefusalKey(claim) })
    }
  }
  if (parsed.data.attribution) await storeCheckoutAttribution(bound.id, parsed.data.attribution)

  // Create the Razorpay order (TEST mode or simulation) and bind it to the
  // session. The amount is the session's FROZEN total.
  const gateway = getPaymentGateway()
  const order = await gateway.createOrder({
    amountPaise: Number(bound.total_paise),
    receipt: `cs_${bound.id}`.slice(0, 40),
    notes: { checkout_session_id: bound.id, source: prep.source, msme_id: msme.id },
    idempotencyKey,
  })

  await writer
    .from('checkout_sessions')
    .update({ razorpay_order_id: order.razorpayOrderId })
    .eq('id', bound.id)
    .is('razorpay_order_id', null)

  // A concurrent request may have bound its order first — return whichever
  // order the session actually carries, so every caller pays the same one.
  const { data: final } = await supabase.from('checkout_sessions').select('razorpay_order_id').eq('id', bound.id).maybeSingle()
  const razorpayOrderId = (final?.razorpay_order_id as string | null | undefined) ?? order.razorpayOrderId

  const timeout = checkoutTimeoutSeconds(bound.expires_at)
  return NextResponse.json({
    checkoutSessionId: bound.id,
    razorpayOrderId,
    amountPaise: Number(bound.total_paise),
    keyId: process.env['NEXT_PUBLIC_RAZORPAY_KEY_ID'] ?? '',
    simulated: !gateway.isReal,
    // ADR 027 (M21) — the Razorpay sheet closes when the frozen session expires.
    ...(timeout !== null ? { checkoutTimeoutSeconds: timeout } : {}),
  })
}
