import 'server-only'
import { evaluateServicesReleaseGate, type MilestoneKind, type ServicesReleaseGate } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'

/**
 * Services evidence gate reader (S0.3). Mirrors lib/mart/release.ts for goods:
 * derives the gate facts from order_milestones + disputes + the buyer's
 * confirmation, then applies the pure evaluateServicesReleaseGate. `enforced`
 * is true only for kind='service' orders placed on/after the
 * `agent_settings.evidence_required_from` cutover (null = never enforced, so
 * existing orders and the pre-cutover period are byte-identical).
 *
 * Consumers: schedulePayout (adds hold reasons) and the admin payout release
 * route (refuses release while the gate holds).
 */

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface MilestoneRow {
  kind: MilestoneKind
  photo_doc_id: string | null
  note: string | null
  created_at: string
}

export interface ServicesEvidence {
  enforced: boolean
  gate: ServicesReleaseGate
  milestones: MilestoneRow[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function getServicesEvidence(admin: Admin, order: any): Promise<ServicesEvidence> {
  const { data: rows } = await admin
    .from('order_milestones')
    .select('kind, photo_doc_id, note, created_at')
    .eq('order_id', order.id)
    .not('kind', 'is', null)
    .order('sort', { ascending: true })
  const milestones: MilestoneRow[] = (rows ?? []).map((r: any) => ({
    kind: r.kind as MilestoneKind,
    photo_doc_id: r.photo_doc_id ?? null,
    note: r.note ?? null,
    created_at: r.created_at as string,
  }))

  const { data: dispute } = await admin.from('disputes').select('id').eq('order_id', order.id).eq('status', 'open').maybeSingle()

  const gate = evaluateServicesReleaseGate({
    milestones: milestones.map((m) => ({ kind: m.kind, photo_doc_id: m.photo_doc_id })),
    buyerConfirmedAt: order.completed_at ? new Date(order.completed_at) : null,
    disputeOpen: !!dispute,
  })

  const cutover = (await getAgentSetting(admin, 'evidence_required_from')) as string | null
  const placedOn = typeof order.created_at === 'string' ? order.created_at.slice(0, 10) : null
  const enforced = !!cutover && !!placedOn && placedOn >= cutover
  return { enforced, gate, milestones }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
