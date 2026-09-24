import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { addonIdsSchema, packageCharge, packageChargeDisplay, resolveAddonSelection } from '@amclub/shared'
import { createAdminClient, createPublicClient } from '@/lib/supabase/server'
import { clientIp, enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { activeAddonsFor, addonsOn } from '@/lib/addons'

const bodySchema = z.object({ packageId: z.string().uuid(), addonIds: addonIdsSchema.default([]) }).strict()

/**
 * E12a / ADR 019 — POST: what a package with the chosen add-ons costs, from the
 * SAME packageCharge checkout freezes (no coupon — the coupon route adds it; no
 * member price). The buy box and checkout render this; the client never adds
 * money. Public (the buy box is on a public page), read-only, per-IP limited.
 * 404 while `addons_enabled` is off; an id that is not an active add-on of this
 * package → 409 addon_changed (the same answer checkout gives).
 */
export async function POST(request: NextRequest) {
  const rl = await enforce(limiters.publicIp, `checkout-preview:${clientIp(request)}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const admin = await createAdminClient()
  if (!(await addonsOn(admin))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 422 })

  // The public read: active packages of active providers only (RLS).
  const { data: pkg } = await createPublicClient()
    .from('packages')
    .select('id, price_paise, discount_bps, delivery_days, revision_count, category:categories(commission_bps)')
    .eq('id', parsed.data.packageId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle()
  if (!pkg) return NextResponse.json({ error: 'package_unavailable' }, { status: 404 })
  const sel = resolveAddonSelection(await activeAddonsFor(admin, pkg.id as string), parsed.data.addonIds)
  if (!sel.ok) return NextResponse.json({ error: 'addon_changed', code: 'addon_changed' }, { status: 409 })

  const commissionBps = (pkg.category as { commission_bps?: number } | null)?.commission_bps ?? 1000
  const charge = packageCharge({
    pricePaise: Number(pkg.price_paise),
    discountBps: Number(pkg.discount_bps ?? 0),
    commissionBps,
    deliveryDays: Number(pkg.delivery_days),
    revisionCount: (pkg.revision_count as number | null) ?? null,
    addons: sel.rows,
  })
  return NextResponse.json(
    {
      display: packageChargeDisplay(charge, { discountBps: Number(pkg.discount_bps ?? 0) }),
      deliveryDays: charge.deliveryDays,
      revisionMax: charge.revisionMax,
      addons: charge.addons,
      addonsPaise: charge.addonsPaise,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
