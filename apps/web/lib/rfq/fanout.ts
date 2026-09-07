import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { createNotificationsBulk } from '@/lib/notifications/create'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * `rfq.fanout` (§5.9) — match providers to an RFQ and notify them.
 * Match = active, not capacity-paused providers listing in the RFQ's category
 * AND in the buyer's state (compliance is local). Writes rfq_matches rows
 * (idempotent) and an in-app notification (+ SMS/WhatsApp behind stubs).
 */
export async function fanoutRfq(admin: Admin, rfqId: string): Promise<{ matched: number }> {
  const { data: rfq } = await admin
    .from('rfqs')
    .select('id, category_id, msme_id, title, kind, mart_category_slug')
    .eq('id', rfqId)
    .maybeSingle()
  if (!rfq) return { matched: 0 }
  // AMC Mart M2 — a goods RFQ fans out to goods-activated SELLERS, never to
  // the services category graph (and services RFQs never reach sellers).
  if (rfq.kind === 'goods') return fanoutGoodsRfq(admin, rfq as { id: string; msme_id: string; title: string; mart_category_slug: string | null })

  const { data: msme } = await admin
    .from('msme_profiles')
    .select('state')
    .eq('id', rfq.msme_id)
    .maybeSingle()
  const state = msme?.state ?? null

  // Providers in this category, active, not paused, in the buyer's state.
  const { data: rows } = await admin
    .from('provider_categories')
    .select('provider:provider_profiles!inner(id, user_id, status, capacity_paused, deleted_at, state)')
    .eq('category_id', rfq.category_id)

  type Prov = { id: string; user_id: string; status: string; capacity_paused: boolean; deleted_at: string | null; state: string | null }
  const providers: Prov[] = []
  for (const r of rows ?? []) {
    const p = (r as { provider: Prov | Prov[] }).provider
    const prov = Array.isArray(p) ? p[0] : p
    if (!prov) continue
    if (prov.status !== 'active' || prov.deleted_at || prov.capacity_paused) continue
    if (state && prov.state !== state) continue
    providers.push(prov)
  }
  if (providers.length === 0) return { matched: 0 }

  // Write match rows (idempotent — PK is (rfq_id, provider_id)).
  await admin
    .from('rfq_matches')
    .upsert(
      providers.map((p) => ({ rfq_id: rfqId, provider_id: p.id })),
      { onConflict: 'rfq_id,provider_id', ignoreDuplicates: true },
    )

  await createNotificationsBulk(admin, providers.map((p) => p.user_id), {
    kind: 'rfq_matched',
    titleI18n: { en: 'New request matched to you', hi: 'आपके लिए नया अनुरोध' },
    bodyI18n: { en: rfq.title, hi: rfq.title },
    link: '/partner/rfqs',
    channels: ['sms', 'whatsapp'],
  })

  return { matched: providers.length }
}

/**
 * Goods RFQ fan-out (M2): active, goods-activated sellers in the buyer's
 * state. Sellers with an ACTIVE listing in the request's Mart category are
 * matched first; if none exist, every goods seller in the state is matched
 * (a spec request is exactly the case where nobody lists the item yet).
 */
async function fanoutGoodsRfq(admin: Admin, rfq: { id: string; msme_id: string; title: string; mart_category_slug: string | null }): Promise<{ matched: number }> {
  const { data: msme } = await admin.from('msme_profiles').select('state').eq('id', rfq.msme_id).maybeSingle()
  const state = msme?.state ?? null
  const { data: sellers } = await admin
    .from('provider_profiles')
    .select('id, user_id, state')
    .eq('status', 'active')
    .eq('sells_goods', true)
    .eq('capacity_paused', false)
    .is('deleted_at', null)
  const inState = (sellers ?? []).filter((s) => !state || s.state === state)
  if (inState.length === 0) return { matched: 0 }
  let chosen = inState
  if (rfq.mart_category_slug) {
    const { data: listed } = await admin
      .from('products')
      .select('seller_id')
      .eq('category_slug', rfq.mart_category_slug)
      .eq('status', 'active')
      .is('deleted_at', null)
      .in('seller_id', inState.map((s) => s.id))
    const ids = new Set((listed ?? []).map((p) => p.seller_id))
    if (ids.size > 0) chosen = inState.filter((s) => ids.has(s.id))
  }
  await admin
    .from('rfq_matches')
    .upsert(chosen.map((p) => ({ rfq_id: rfq.id, provider_id: p.id })), { onConflict: 'rfq_id,provider_id', ignoreDuplicates: true })
  await createNotificationsBulk(admin, chosen.map((p) => p.user_id), {
    kind: 'rfq_matched',
    titleI18n: { en: 'New goods request for you', hi: 'आपके लिए नया माल अनुरोध' },
    bodyI18n: { en: rfq.title, hi: rfq.title },
    link: '/partner/rfqs',
    channels: ['sms', 'whatsapp'],
  })
  return { matched: chosen.length }
}
