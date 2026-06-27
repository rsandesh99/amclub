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
    .select('id, category_id, msme_id, title')
    .eq('id', rfqId)
    .maybeSingle()
  if (!rfq) return { matched: 0 }

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
