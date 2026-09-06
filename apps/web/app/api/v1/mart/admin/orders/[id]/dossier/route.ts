import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { getGoodsDossier } from '@/lib/mart/release'

/**
 * Payout-evidence dossier for a goods order (MART_DESIGN.md §4.3/§5): the
 * release-gate facts + evidence document links + frozen line items, so the
 * founder's one-tap release sees exactly what the gate sees.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const { id } = await params
  const admin = await createAdminClient()
  const { data: order } = await admin.from('orders').select('*').eq('id', id).maybeSingle()
  if (!order || order.kind !== 'goods') return NextResponse.json({ error: 'Not a goods order' }, { status: 404 })
  const dossier = await getGoodsDossier(admin, order)
  const docs = dossier.evidenceDocIds.length
    ? await admin.from('order_documents').select('id, kind, file_name, file_url').in('id', dossier.evidenceDocIds)
    : { data: [] as { id: string; kind: string; file_name: string; file_url: string }[] }
  const evidence = await Promise.all(
    (docs.data ?? []).map(async (d) => {
      const { data: signed } = await admin.storage.from('order-documents').createSignedUrl(d.file_url, 15 * 60)
      return { id: d.id, kind: d.kind, fileName: d.file_name, signedUrl: signed?.signedUrl ?? null }
    }),
  )
  const { data: payout } = await admin.from('payouts').select('id, status, amount_paise, tds_section, tds_bps, tds_paise').eq('order_id', id).maybeSingle()
  return NextResponse.json({ dossier, evidence, payout, order: { id: order.id, order_number: order.order_number, status: order.status, total_paise: order.total_paise, provider_earning_paise: order.provider_earning_paise, delivery_snapshot: order.delivery_snapshot } }, { headers: { 'Cache-Control': 'private, no-store' } })
}
