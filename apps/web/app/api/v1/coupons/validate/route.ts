import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { evaluateCoupon, COUPON_ERROR_KEY } from '@/lib/coupons/apply'
import { COUPONS_ENABLED } from '@/lib/flags'

const bodySchema = z
  .object({
    code: z.string().trim().min(1).max(40),
    packageId: z.string().uuid().optional(),
    quoteId: z.string().uuid().optional(),
  })
  .refine((d) => !!d.packageId !== !!d.quoteId, { message: 'Provide exactly one of packageId or quoteId' })

/**
 * POST — validate a coupon against a specific package/quote and return the
 * exact paise discount (or a clear rejection key). Used by the checkout UI
 * before payment; the authoritative re-evaluation still happens server-side at
 * checkout (the discount is frozen on the checkout_session).
 */
export async function POST(request: NextRequest) {
  // Flag-gated (default OFF). Dormant when disabled — behaves as if absent.
  if (!COUPONS_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rl = await enforce(limiters.couponValidate, `coupon:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { code, packageId, quoteId } = parsed.data

  let taxableBeforeCoupon = 0
  let categoryId: string | null = null

  if (packageId) {
    const { data: p } = await supabase
      .from('packages')
      .select('price_paise, discount_bps, category_id, status')
      .eq('id', packageId)
      .eq('status', 'active')
      .maybeSingle()
    if (!p) return NextResponse.json({ ok: false, error: 'package_unavailable' }, { status: 404 })
    taxableBeforeCoupon = Number(p.price_paise) - Math.round((Number(p.price_paise) * (p.discount_bps ?? 0)) / 10000)
    categoryId = p.category_id
  } else {
    const { data: q } = await supabase
      .from('quotes')
      .select('price_paise, rfq:rfqs!inner(category_id)')
      .eq('id', quoteId!)
      .maybeSingle()
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const quote = q as any
    if (!quote) return NextResponse.json({ ok: false, error: 'quote_unavailable' }, { status: 404 })
    taxableBeforeCoupon = Number(quote.price_paise)
    categoryId = quote.rfq?.category_id ?? null
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  // Read the coupon via the admin client: the public RLS policy hides expired /
  // inactive coupons, which would collapse every rejection into "not found".
  // evaluateCoupon then returns the precise reason (expired / usage / etc.).
  const adminDb = await createAdminClient()
  const { data: coupon } = await adminDb.from('coupons').select('*').eq('code', code.toUpperCase()).maybeSingle()
  const result = evaluateCoupon(coupon, taxableBeforeCoupon, categoryId)

  if (result.error) {
    return NextResponse.json({ ok: false, error: COUPON_ERROR_KEY[result.error] })
  }
  return NextResponse.json({ ok: true, discountPaise: result.discountPaise, code: result.code, kind: result.kind })
}
