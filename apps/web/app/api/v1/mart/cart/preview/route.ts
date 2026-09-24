import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { martApiGate } from '@/lib/mart/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { prepareGoodsCheckout } from '@/lib/mart/totals'
import { getMartSetting } from '@/lib/mart/config'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'

const bodySchema = z.object({
  items: z.array(z.object({ product_id: z.string().uuid(), qty: z.number().int().positive().max(1_000_000) })).min(1).max(20),
  /** E16 N42 — preview a sample (one listing, qty 1, at its sample price). */
  sample: z.boolean().optional(),
})

/**
 * Server-computed cart totals for display (FRONTEND.md §8: clients never do
 * money arithmetic). Same preparation as checkout, no session created.
 */
export async function POST(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const rl = await enforce(limiters.search, `mart-preview:${clientIp(request)}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { items, sample } = parsed.data
  if (sample && (items.length !== 1 || items[0]!.qty !== 1)) return NextResponse.json({ error: { code: 'sample_one_unit' } }, { status: 422 })
  const admin = await createAdminClient()
  const [prepared, deliveryDays] = await Promise.all([
    prepareGoodsCheckout(admin, items, { sample: !!sample }),
    getMartSetting<number | string>(admin, 'goods_delivery_days', 3).then(Number),
  ])
  if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: prepared.status })
  const { prep } = prepared
  return NextResponse.json(
    {
      sellerName: prep.sellerName,
      deliveryDays,
      lineItems: prep.lineItems,
      amounts: {
        taxablePaise: prep.amounts.taxablePaise,
        gstPaise: prep.amounts.gstPaise,
        totalPaise: prep.amounts.totalPaise,
        afterItcPaise: prep.afterItcPaise,
        itcPaise: prep.itcPaise,
      },
      returnWindowHours: prep.returnWindowHours,
      // E16 N43 — per-line flags for "Not returnable" / "ITC may not be available".
      nonReturnableProductIds: prep.nonReturnableProductIds,
      itcIneligibleProductIds: prep.itcIneligibleProductIds,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
