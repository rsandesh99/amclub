import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { rfqSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { fanoutRfq } from '@/lib/rfq/fanout'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'
import { MART_ENABLED } from '@/lib/flags'
import { getMartCategory } from '@/lib/mart/config'

const RFQ_TTL_MS = 72 * 60 * 60 * 1000

/** Create an RFQ (status 'open', 72h expiry, 7-quote cap) and fan out to matched
 *  providers. Requires a complete MSME profile (state + sector — §1.5 M5/§3.3). */
export async function POST(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rl = await enforce(limiters.rfqCreate, `rfq:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const json = await request.json().catch(() => null)
  const parsed = rfqSchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const d = parsed.data

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) {
    return NextResponse.json({ error: 'profile_incomplete' }, { status: 403 })
  }

  // §1.5 M5 / §3.3 — RFQ matching needs state + sector. Gate on them.
  const { data: profile } = await admin
    .from('msme_profiles')
    .select('state, sector')
    .eq('id', actor.msmeId)
    .maybeSingle()
  if (!profile?.state || !profile?.sector) {
    return NextResponse.json({ error: 'profile_incomplete' }, { status: 403 })
  }

  // AMC Mart M2 — goods RFQ: a Mart category + goods spec instead of a services
  // template. Does not exist while the flag is off (same hard-404 as every
  // Mart surface); the services branch below is byte-identical to before.
  let categoryId: string | null = null
  let martCategorySlug: string | null = null
  if (d.kind === 'goods') {
    if (!MART_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const cat = await getMartCategory(admin, d.mart_category_slug!)
    if (!cat || !cat.is_active || cat.bis_blocked) return NextResponse.json({ error: 'Invalid category' }, { status: 422 })
    martCategorySlug = cat.slug
  } else {
    const { data: category } = await admin
      .from('categories')
      .select('id')
      .eq('slug', d.category_slug!)
      .maybeSingle()
    if (!category) return NextResponse.json({ error: 'Invalid category' }, { status: 422 })
    categoryId = category.id
  }

  const { data: rfq, error } = await admin
    .from('rfqs')
    .insert({
      msme_id: actor.msmeId,
      category_id: categoryId,
      ...(d.kind === 'goods' ? { kind: 'goods', mart_category_slug: martCategorySlug, goods_spec: d.goods_spec } : {}),
      title: d.title,
      details: d.details,
      attachments: d.attachments ?? [],
      budget_min_paise: d.budget_min_paise ?? null,
      budget_max_paise: d.budget_max_paise ?? null,
      needed_by: d.needed_by ?? null,
      // Phase 8b — transcript + parse when the RFQ began as voice (quality
      // review + training signal). Pure storage; matching is unaffected.
      voice_meta: d.voice_meta ?? null,
      status: 'open',
      max_quotes: 7,
      quote_count: 0,
      expires_at: new Date(Date.now() + RFQ_TTL_MS).toISOString(),
    })
    .select('id')
    .single()
  if (error || !rfq) return serverError('[rfq POST]', error)

  // Fan-out (match + notify). Best-effort — the RFQ exists regardless.
  let matched = 0
  try {
    ;({ matched } = await fanoutRfq(admin, rfq.id))
  } catch (e) {
    console.error('[rfq fanout]', e)
  }

  return NextResponse.json({ rfqId: rfq.id, matched })
}
