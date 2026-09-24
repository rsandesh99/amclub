import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { createNotificationsBulk } from '@/lib/notifications/create'
import { RFQ_GOODS_LIST_COLS, isGoodsRow } from '@/lib/mart/staged-columns'
import { fanoutGoodsRfq } from '@/lib/mart/goods-fanout'
import { notifyText, sameText } from '@/lib/i18n/notify'
import { shadowAtFanout } from '@/lib/shadow'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * `rfq.fanout` (§5.9) — match providers to an RFQ and notify them.
 * Match = active, not capacity-paused providers listing in the RFQ's category
 * AND in the buyer's state (compliance is local). Writes rfq_matches rows
 * (idempotent) and an in-app notification (+ SMS/WhatsApp behind stubs).
 */
export async function fanoutRfq(admin: Admin, rfqId: string): Promise<{ matched: number }> {
  const { data } = await admin
    .from('rfqs')
    // Staged goods columns only when the flag is on (fragment is '' otherwise —
    // naming a column prod lacks would fail the whole select and match nobody).
    .select('id, category_id, msme_id, title' + RFQ_GOODS_LIST_COLS)
    .eq('id', rfqId)
    .maybeSingle()
  const rfq = data as unknown as
    | { id: string; category_id: string; msme_id: string; title: string; kind?: string; mart_category_slug?: string | null }
    | null
  if (!rfq) return { matched: 0 }
  // AMC Mart M2 — a goods RFQ fans out to goods-activated SELLERS, never to
  // the services category graph (and services RFQs never reach sellers).
  if (isGoodsRow(rfq)) return fanoutGoodsRfq(admin, { id: rfq.id, msme_id: rfq.msme_id, title: rfq.title, mart_category_slug: rfq.mart_category_slug ?? null })

  const { data: msme } = await admin
    .from('msme_profiles')
    .select('state, user_id')
    .eq('id', rfq.msme_id)
    .maybeSingle()
  const state = msme?.state ?? null
  // Audit M22 (ADR 029) — the buyer's own provider profile is never matched to their request.
  const buyerUserId = (msme?.user_id as string | undefined) ?? null

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
    if (buyerUserId && prov.user_id === buyerUserId) continue
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
  // E15 F10 — shadow predictions (CAD price band, provider fit %): logged, shown to nobody; each behind its own switch.
  await shadowAtFanout(admin, { rfqId, providerIds: providers.map((p) => p.id) })

  await createNotificationsBulk(admin, providers.map((p) => p.user_id), {
    kind: 'rfq_matched',
    titleI18n: notifyText('rfq_matched.title'),
    bodyI18n: sameText(rfq.title),
    link: `/partner/rfqs/${rfqId}`,
    channels: ['sms', 'whatsapp'],
  })

  return { matched: providers.length }
}
