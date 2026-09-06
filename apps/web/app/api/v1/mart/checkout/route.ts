import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { goodsCheckoutSchema } from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getPaymentGateway } from '@/lib/payments'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { prepareGoodsCheckout } from '@/lib/mart/totals'
import { getMartSetting } from '@/lib/mart/config'
import { serverError } from '@/lib/api/errors'

/**
 * Goods checkout (MART_DESIGN.md §4.3) — the SAME frozen-session → gateway
 * order → webhook-materialises-the-order flow as services checkout. The row
 * carries kind='goods' + the line-item and delivery snapshots; totals are
 * computed server-side from live tiers (the client sends ids + quantities).
 */
export async function POST(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rl = await enforce(limiters.checkout, `checkout:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = goodsCheckoutSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { items, delivery, gstInvoice, idempotencyKey } = parsed.data

  // Idempotent replay → existing session.
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

  const { data: msme } = await supabase.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!msme) return NextResponse.json({ error: 'Complete your business profile first' }, { status: 403 })

  const admin = await createAdminClient()
  const prepared = await prepareGoodsCheckout(admin, items)
  if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: prepared.status })
  const { prep } = prepared
  const deliveryDays = Number(await getMartSetting<number | string>(admin, 'goods_delivery_days', 3))

  const { data: session, error: insErr } = await supabase
    .from('checkout_sessions')
    .upsert(
      {
        msme_id: msme.id,
        provider_id: prep.sellerId,
        source: 'catalog',
        package_id: null,
        quote_id: null,
        title: prep.title,
        scope_snapshot: { kind: 'goods', seller_name: prep.sellerName, categories: prep.categories },
        price_paise: prep.amounts.pricePaise,
        discount_paise: 0,
        gst_paise: prep.amounts.gstPaise,
        total_paise: prep.amounts.totalPaise,
        commission_bps: prep.amounts.commissionBps,
        commission_paise: prep.amounts.commissionPaise,
        provider_earning_paise: prep.amounts.providerEarningPaise,
        delivery_days: deliveryDays,
        revision_max: null,
        coupon_code: null,
        gst_invoice: gstInvoice ?? null,
        kind: 'goods',
        line_items: prep.lineItems,
        delivery_snapshot: delivery,
        idempotency_key: idempotencyKey,
        status: 'created',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .single()
  if (insErr || !session) return serverError('[mart/checkout] session insert', insErr)

  const gateway = getPaymentGateway()
  const order = await gateway.createOrder({
    amountPaise: prep.amounts.totalPaise,
    receipt: `cs_${session.id}`.slice(0, 40),
    notes: { checkout_session_id: session.id, source: 'catalog', msme_id: msme.id, kind: 'goods' },
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
    amountPaise: prep.amounts.totalPaise,
    keyId: process.env['NEXT_PUBLIC_RAZORPAY_KEY_ID'] ?? '',
    simulated: !gateway.isReal,
    // Server-computed display (FRONTEND.md §8): the client renders, never derives.
    amounts: {
      taxablePaise: prep.amounts.taxablePaise,
      gstPaise: prep.amounts.gstPaise,
      totalPaise: prep.amounts.totalPaise,
      afterItcPaise: prep.amounts.taxablePaise,
    },
    lineItems: prep.lineItems,
    sellerName: prep.sellerName,
    deliveryDays,
  })
}
