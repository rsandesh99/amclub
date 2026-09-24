import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { createNotificationsBulk } from '@/lib/notifications/create'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// Lives under lib/mart because it names staged columns (provider_profiles.
// sells_goods, products) that prod lacks until the Launch Gate. Only reached
// from lib/rfq/fanout.ts when isGoodsRow() is true (flag on + kind='goods').

/**
 * Goods RFQ fan-out (M2): active, goods-activated sellers in the buyer's
 * state. Sellers with an ACTIVE listing in the request's Mart category are
 * matched first; if none exist, every goods seller in the state is matched
 * (a spec request is exactly the case where nobody lists the item yet).
 */
export async function fanoutGoodsRfq(admin: Admin, rfq: { id: string; msme_id: string; title: string; mart_category_slug: string | null }): Promise<{ matched: number }> {
  const { data: msme } = await admin.from('msme_profiles').select('state, user_id').eq('id', rfq.msme_id).maybeSingle()
  const state = msme?.state ?? null
  // Audit M22 (ADR 027) — the buyer's own seller profile is never matched to their request.
  const buyerUserId = (msme?.user_id as string | undefined) ?? null
  const { data: sellers } = await admin
    .from('provider_profiles')
    .select('id, user_id, state')
    .eq('status', 'active')
    .eq('sells_goods', true)
    .eq('capacity_paused', false)
    .is('deleted_at', null)
  const inState = (sellers ?? []).filter((s) => (!state || s.state === state) && (!buyerUserId || s.user_id !== buyerUserId))
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
    link: `/partner/rfqs/${rfq.id}`,
    channels: ['sms', 'whatsapp'],
  })
  return { matched: chosen.length }
}
