import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { computeOrderAmounts } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { getPaymentGateway } from '@/lib/payments'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { evaluateCoupon } from '@/lib/coupons/apply'

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
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Per-user request cap (idempotencyKey already prevents double-charge).
  const rl = await enforce(limiters.checkout, `checkout:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { packageId, quoteId, gstInvoice, idempotencyKey } = parsed.data
  // Coupon codes are stored upper-cased — normalise before lookup + freezing.
  const couponCode = parsed.data.couponCode?.trim().toUpperCase() || undefined

  // Idempotent: a repeat with the same key returns the existing session/order.
  const { data: existing } = await supabase
    .from('checkout_sessions')
    .select('id, razorpay_order_id, total_paise')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (existing?.razorpay_order_id) {
    return NextResponse.json({
      checkoutSessionId: existing.id,
      razorpayOrderId: existing.razorpay_order_id,
      amountPaise: existing.total_paise,
      keyId: process.env['NEXT_PUBLIC_RAZORPAY_KEY_ID'] ?? '',
      idempotent: true,
    })
  }

  // Buyer's MSME profile (RLS: owner read).
  const { data: msme } = await supabase.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!msme) return NextResponse.json({ error: 'Complete your business profile first' }, { status: 403 })

  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prep: Prep

  if (packageId) {
    const { data: pkg } = await supabase
      .from('packages')
      .select(
        'id, provider_id, category_id, title_i18n, scope_included, scope_excluded, deliverables, requirements_template, price_paise, discount_bps, member_extra_discount_bps, delivery_days, revision_count, status, provider:provider_profiles!inner(id, status), category:categories(commission_bps)',
      )
      .eq('id', packageId)
      .eq('status', 'active')
      .maybeSingle()

    const p = pkg as any
    if (!p || p.provider?.status !== 'active') {
      return NextResponse.json({ error: 'Package not available' }, { status: 404 })
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
        'id, status, provider_id, price_paise, delivery_days, scope, rfq:rfqs!inner(id, msme_id, category_id, title, status, details)',
      )
      .eq('id', quoteId!)
      .maybeSingle()
    const quote = q as any
    const rfq = quote?.rfq
    if (!quote || !rfq) return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    if (rfq.msme_id !== msme.id) return NextResponse.json({ error: 'Not your RFQ' }, { status: 403 })
    if (quote.status !== 'submitted') return NextResponse.json({ error: 'Quote no longer available' }, { status: 409 })
    if (!(rfq.status === 'open' || rfq.status === 'quoted')) {
      return NextResponse.json({ error: 'This request is closed' }, { status: 409 })
    }

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
      amounts: computeOrderAmounts({
        pricePaise: Number(quote.price_paise),
        discountBps: 0,
        commissionBps,
      }),
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
        idempotency_key: idempotencyKey,
        status: 'created',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .single()

  if (insErr || !session) {
    console.error('[checkout] session insert', insErr)
    return NextResponse.json({ error: 'Checkout failed' }, { status: 500 })
  }

  // Create the Razorpay order (TEST mode or simulation) and bind it to the session.
  const gateway = getPaymentGateway()
  const order = await gateway.createOrder({
    amountPaise: amounts.totalPaise,
    receipt: `cs_${session.id}`.slice(0, 40),
    notes: { checkout_session_id: session.id, source: prep.source, msme_id: msme.id },
    idempotencyKey,
  })

  await supabase
    .from('checkout_sessions')
    .update({ razorpay_order_id: order.razorpayOrderId })
    .eq('id', session.id)
    .is('razorpay_order_id', null)

  return NextResponse.json({
    checkoutSessionId: session.id,
    razorpayOrderId: order.razorpayOrderId,
    amountPaise: amounts.totalPaise,
    keyId: process.env['NEXT_PUBLIC_RAZORPAY_KEY_ID'] ?? '',
    simulated: !gateway.isReal,
  })
}
