import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { computeOrderAmounts, isValidGstin, quoteChargeAmounts } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { RFQ_GOODS_COLS, QUOTE_GOODS_COLS, isGoodsRow } from '@/lib/mart/staged-columns'
import { getPaymentGateway } from '@/lib/payments'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { evaluateCoupon } from '@/lib/coupons/apply'
import { COUPONS_ENABLED } from '@/lib/flags'
import { createAdminClient } from '@/lib/supabase/server'
import { prepareGoodsQuoteCheckout, type GoodsQuotePrep } from '@/lib/mart/goods-rfq'

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
  })
  // Exactly one source — package (Buy Now) OR quote (accepted RFQ quote).
  .refine((d) => !!d.packageId !== !!d.quoteId, {
    message: 'Provide exactly one of packageId or quoteId',
  })

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

function fail(status: number, code: CheckoutErrorCode, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, code, ...(extra ?? {}) }, { status })
}

interface SessionRow {
  id: string
  razorpay_order_id: string | null
  total_paise: number
  status: string
  order_id: string | null
}
const SESSION_COLS = 'id, razorpay_order_id, total_paise, status, order_id'
/** A session whose payment was captured (materialize_order claimed it). */
const isPaidSession = (s: SessionRow) => !!s.order_id || s.status === 'materializing' || s.status === 'materialized'

/**
 * Resume an existing session (same idempotency key, or a live session for the
 * SAME quote). Never mints a second Razorpay order; once the session is paid
 * the client is sent to the order instead of re-opening the payment sheet.
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
  return NextResponse.json({
    checkoutSessionId: s.id,
    razorpayOrderId: s.razorpay_order_id,
    amountPaise: Number(s.total_paise),
    keyId: process.env['NEXT_PUBLIC_RAZORPAY_KEY_ID'] ?? '',
    idempotent: true,
    // The resume path must say whether to simulate, or a stable client key
    // would open the Razorpay sheet on a simulated order id.
    simulated: !getPaymentGateway().isReal,
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
  amounts: ReturnType<typeof computeOrderAmounts>
}

export async function POST(request: NextRequest) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return fail(401, 'unauthorized', 'Unauthorized')
  const scope = await requireToolScope('place_order')
  if (scope) return scope

  // Per-user request cap (idempotencyKey already prevents double-charge).
  const rl = await enforce(limiters.checkout, `checkout:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten(), code: 'invalid_body' }, { status: 422 })
  const { packageId, quoteId, idempotencyKey } = parsed.data
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
  if (existing?.razorpay_order_id) return resumeResponse(existing as SessionRow)

  // Buyer's MSME profile (RLS: owner read).
  const { data: msme } = await supabase.from('msme_profiles').select('id, deleted_at').eq('user_id', userId).maybeSingle()
  if (!msme) return fail(403, 'profile_incomplete', 'Complete your business profile first')
  if (msme.deleted_at) return fail(403, 'account_suspended', 'Your buyer account is suspended')

  /* eslint-disable @typescript-eslint/no-explicit-any */
  let goodsPrep: GoodsQuotePrep | null = null
  let prep: Prep

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

    let extraDiscountPaise = 0
    if (couponCode) {
      const { data: coupon } = await supabase.from('coupons').select('*').eq('code', couponCode).maybeSingle()
      const taxableBeforeCoupon = p.price_paise - Math.round((p.price_paise * p.discount_bps) / 10000)
      extraDiscountPaise = evaluateCoupon(coupon, taxableBeforeCoupon, p.category_id).discountPaise
    }

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
      deliveryDays: p.delivery_days,
      revisionMax: p.revision_count,
      amounts: computeOrderAmounts({
        pricePaise: Number(p.price_paise),
        discountBps: p.discount_bps,
        commissionBps,
        extraDiscountPaise,
      }),
    }
  } else {
    // Quote branch — accepting a submitted quote on the buyer's own RFQ.
    const { data: q } = await supabase
      .from('quotes')
      .select(
        'id, status, provider_id, price_paise, gst_included, delivery_days, scope' + QUOTE_GOODS_COLS + ', rfq:rfqs!inner(id, msme_id, category_id, title, status, details' + RFQ_GOODS_COLS + ')',
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
          .select(SESSION_COLS + ', quote_id, expires_at, created_at')
          .in('quote_id', siblingIds)
          .in('status', ['created', 'materializing', 'materialized'])
          .order('created_at', { ascending: false })
        const rows = (sessions ?? []) as unknown as (SessionRow & { quote_id: string; expires_at: string | null })[]
        const paid = rows.find(isPaidSession)
        if (paid) {
          if (paid.quote_id === quote.id) return resumeResponse(paid)
          return fail(409, 'rfq_already_paid', 'A quote on this request has already been paid for', { orderId: paid.order_id })
        }
        const now = Date.now()
        const live = rows.filter((r) => r.razorpay_order_id && (!r.expires_at || new Date(r.expires_at).getTime() > now))
        const same = live.find((r) => r.quote_id === quote.id)
        if (same) return resumeResponse(same)
        const other = live.find((r) => r.quote_id !== quote.id)
        if (other) {
          return fail(409, 'rfq_checkout_in_progress', 'A payment for another quote on this request is in progress', { retryAfter: other.expires_at })
        }
      }
    }

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
        amounts: g.prep.amounts as unknown as ReturnType<typeof computeOrderAmounts>,
      }
    } else {
    const { data: cat } = await supabase.from('categories').select('commission_bps').eq('id', rfq.category_id).maybeSingle()
    const commissionBps: number = cat?.commission_bps ?? 1000

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
      deliveryDays: quote.delivery_days,
      revisionMax: null,
      // ADR-015 — a price the provider marked "GST included" is what the buyer
      // pays: GST is carved out of it, never added on top. Excluded or unstated
      // (the confirm sheet says GST is applied at checkout) adds it as before.
      // ADR-017 — the ONE shared rule (quoteChargeAmounts); compare and the provider preview use it too.
      amounts: quoteChargeAmounts({ pricePaise: Number(quote.price_paise), gstIncluded: quote.gst_included ?? null, commissionBps }),
    }
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const { amounts } = prep

  // Create the checkout session (frozen). ON CONFLICT guards a racing double-submit.
  const { data: session, error: insErr } = await supabase
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
        coupon_code: couponCode ?? null,
        gst_invoice: gstInvoice ?? null,
        // Goods-quote sessions carry the goods columns; every other session
        // leaves them at their defaults exactly as before.
        ...(goodsPrep ? { kind: 'goods', line_items: goodsPrep.lineItems, delivery_snapshot: goodsPrep.delivery } : {}),
        idempotency_key: idempotencyKey,
        status: 'created',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id, total_paise')
    .maybeSingle()

  // ignoreDuplicates returns no row when this key already has a session (a
  // racing double-submit, or a retry after the gateway call below failed).
  // Re-read it so the SAME frozen session is bound — never a second one.
  let bound = (session as { id: string; total_paise: number } | null) ?? null
  if (!bound && !insErr) {
    const { data: again } = await supabase.from('checkout_sessions').select(SESSION_COLS).eq('idempotency_key', idempotencyKey).maybeSingle()
    if (again?.razorpay_order_id) return resumeResponse(again as SessionRow)
    bound = again ? { id: again.id as string, total_paise: Number(again.total_paise) } : null
  }
  if (insErr || !bound) {
    console.error('[checkout] session insert', insErr)
    return fail(500, 'checkout_failed', 'Checkout failed')
  }

  // Create the Razorpay order (TEST mode or simulation) and bind it to the
  // session. The amount is the session's FROZEN total.
  const gateway = getPaymentGateway()
  const order = await gateway.createOrder({
    amountPaise: Number(bound.total_paise),
    receipt: `cs_${bound.id}`.slice(0, 40),
    notes: { checkout_session_id: bound.id, source: prep.source, msme_id: msme.id },
    idempotencyKey,
  })

  await supabase
    .from('checkout_sessions')
    .update({ razorpay_order_id: order.razorpayOrderId })
    .eq('id', bound.id)
    .is('razorpay_order_id', null)

  // A concurrent request may have bound its order first — return whichever
  // order the session actually carries, so every caller pays the same one.
  const { data: final } = await supabase.from('checkout_sessions').select('razorpay_order_id').eq('id', bound.id).maybeSingle()
  const razorpayOrderId = (final?.razorpay_order_id as string | null | undefined) ?? order.razorpayOrderId

  return NextResponse.json({
    checkoutSessionId: bound.id,
    razorpayOrderId,
    amountPaise: Number(bound.total_paise),
    keyId: process.env['NEXT_PUBLIC_RAZORPAY_KEY_ID'] ?? '',
    simulated: !gateway.isReal,
  })
}
