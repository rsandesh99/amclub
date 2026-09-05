import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { martApiGate } from '@/lib/mart/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { prepareGoodsCheckout } from '@/lib/mart/totals'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'

const bodySchema = z.object({
  items: z.array(z.object({ product_id: z.string().uuid(), qty: z.number().int().positive().max(1_000_000) })).min(1).max(20),
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
  const admin = await createAdminClient()
  const prepared = await prepareGoodsCheckout(admin, parsed.data.items)
  if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: prepared.status })
  const { prep } = prepared
  return NextResponse.json(
    {
      sellerName: prep.sellerName,
      lineItems: prep.lineItems,
      amounts: {
        taxablePaise: prep.amounts.taxablePaise,
        gstPaise: prep.amounts.gstPaise,
        totalPaise: prep.amounts.totalPaise,
        afterItcPaise: prep.amounts.taxablePaise,
      },
      returnWindowHours: prep.returnWindowHours,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
