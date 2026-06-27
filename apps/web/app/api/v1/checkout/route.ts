import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { computeOrderAmounts } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { getPaymentGateway } from '@/lib/payments'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

const bodySchema = z.object({
  packageId: z.string().uuid(),
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

/* eslint-disable @typescript-eslint/no-explicit-any */
function resolveCouponDiscountPaise(coupon: any, taxableBeforeCoupon: number, categoryId: string): number {
  if (!coupon) return 0
  const now = new Date()
  if (!coupon.is_active) return 0
  if (coupon.valid_from && new Date(coupon.valid_from) > now) return 0
  if (coupon.valid_to && new Date(coupon.valid_to) < now) return 0
  if (coupon.usage_limit != null && coupon.used_count >= coupon.usage_limit) return 0
  if (coupon.category_id && coupon.category_id !== categoryId) return 0

  let discount = 0
  if (coupon.kind === 'percent') discount = Math.round((taxableBeforeCoupon * coupon.value_bps) / 10000)
  else if (coupon.kind === 'fixed') discount = coupon.value_bps // paise for fixed coupons
  if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise)
  return Math.max(0, Math.min(discount, taxableBeforeCoupon))
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function POST(request: NextRequest) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Per-user request cap (idempotencyKey already prevents double-charge).
  const rl = await enforce(limiters.checkout, `checkout:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { packageId, couponCode, gstInvoice, idempotencyKey } = parsed.data

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
  const { data: msme } = await supabase
    .from('msme_profiles')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()
  if (!msme) {
    return NextResponse.json({ error: 'Complete your business profile first' }, { status: 403 })
  }

  // Active package + its provider + category commission (public read).
  const { data: pkg } = await supabase
    .from('packages')
    .select(
      'id, provider_id, category_id, title_i18n, scope_included, scope_excluded, deliverables, requirements_template, price_paise, discount_bps, member_extra_discount_bps, delivery_days, revision_count, status, provider:provider_profiles!inner(id, status), category:categories(commission_bps)',
    )
    .eq('id', packageId)
    .eq('status', 'active')
    .maybeSingle()

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const p = pkg as any
  if (!p || p.provider?.status !== 'active') {
    return NextResponse.json({ error: 'Package not available' }, { status: 404 })
  }
  const commissionBps: number = p.category?.commission_bps ?? 1000

  // Optional coupon → extra discount, folded into frozen amounts.
  let extraDiscountPaise = 0
  if (couponCode) {
    const { data: coupon } = await supabase
      .from('coupons')
      .select('*')
      .eq('code', couponCode)
      .maybeSingle()
    const taxableBeforeCoupon =
      p.price_paise - Math.round((p.price_paise * p.discount_bps) / 10000)
    extraDiscountPaise = resolveCouponDiscountPaise(coupon, taxableBeforeCoupon, p.category_id)
  }

  const amounts = computeOrderAmounts({
    pricePaise: Number(p.price_paise),
    discountBps: p.discount_bps,
    commissionBps,
    extraDiscountPaise,
  })

  const scopeSnapshot = {
    title: p.title_i18n,
    scopeIncluded: p.scope_included ?? [],
    scopeExcluded: p.scope_excluded ?? [],
    deliverables: p.deliverables ?? [],
    requirementsTemplate: p.requirements_template ?? null,
  }
  const title = p.title_i18n?.en ?? 'Service order'
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Create the checkout session (frozen). ON CONFLICT guards a racing double-submit.
  const { data: session, error: insErr } = await supabase
    .from('checkout_sessions')
    .upsert(
      {
        msme_id: msme.id,
        provider_id: p.provider_id,
        source: 'package',
        package_id: p.id,
        title,
        scope_snapshot: scopeSnapshot,
        price_paise: amounts.pricePaise,
        discount_paise: amounts.discountPaise,
        gst_paise: amounts.gstPaise,
        total_paise: amounts.totalPaise,
        commission_bps: amounts.commissionBps,
        commission_paise: amounts.commissionPaise,
        provider_earning_paise: amounts.providerEarningPaise,
        delivery_days: p.delivery_days,
        revision_max: p.revision_count,
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
    return NextResponse.json({ error: insErr?.message ?? 'Checkout failed' }, { status: 500 })
  }

  // Create the Razorpay order (TEST mode or simulation) and bind it to the session.
  const gateway = getPaymentGateway()
  const order = await gateway.createOrder({
    amountPaise: amounts.totalPaise,
    receipt: `cs_${session.id}`.slice(0, 40),
    notes: { checkout_session_id: session.id, package_id: p.id, msme_id: msme.id },
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
