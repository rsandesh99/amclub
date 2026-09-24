import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isUnstartedChild, type BundleMilestoneRow } from '@amclub/shared'
import { getAgentSetting } from '@/lib/agent/settings'
import { applyTransition, type Actor } from '@/lib/orders/transitions'
import type { createAdminClient } from '@/lib/supabase/server'

/**
 * E12c / ADR 021 — compliance bundles. The switch is `bundles_enabled`
 * (default off); every reader here is tolerant (switch off, tables absent
 * before 0067, any error → "not a bundle" / nothing), so a package sells as a
 * single order exactly as before while it is dark.
 */
export async function bundlesOn(admin: SupabaseClient): Promise<boolean> {
  try {
    return (await getAgentSetting(admin, 'bundles_enabled')) === true
  } catch {
    return false
  }
}

export const MILESTONE_COLS = 'seq, label_i18n, due_offset_days, share_bps'

/** The package's milestones in order ([] = not a bundle). */
export async function milestonesFor(db: SupabaseClient, packageId: string): Promise<BundleMilestoneRow[]> {
  try {
    const { data, error } = await db.from('bundle_milestones').select(MILESTONE_COLS).eq('package_id', packageId).order('seq')
    if (error) return []
    const rows = (data ?? []) as BundleMilestoneRow[]
    return rows.length >= 2 ? rows : []
  } catch {
    return []
  }
}

/** For buyer surfaces: milestones to sell, or [] while the switch is off. */
export async function offeredMilestones(admin: SupabaseClient, packageId: string): Promise<BundleMilestoneRow[]> {
  if (!(await bundlesOn(admin))) return []
  return milestonesFor(admin, packageId)
}

export interface PlanChild {
  id: string
  seq: number
  title: string
  status: string
  totalPaise: number
  availableAt: string | null
  dueAt: string | null
  orderNumber: string | null
}
export interface PlanView {
  id: string
  title: string
  createdAt: string
  totalPaise: number
  children: PlanChild[]
}

/** A buyer's plans (newest first) with their child orders; [] before 0067 or while off. */
export async function plansForBuyer(admin: SupabaseClient, msmeId: string): Promise<PlanView[]> {
  try {
    const { data: ps, error } = await admin.from('bundle_purchases').select('id, title, created_at, total_paise').eq('msme_id', msmeId).order('created_at', { ascending: false }).limit(50)
    if (error || !ps?.length) return []
    const { data: kids } = await admin.from('orders').select('id, bundle_purchase_id, bundle_seq, title, status, total_paise, available_at, due_at, order_number').in('bundle_purchase_id', ps.map((p) => p.id as string)).order('bundle_seq')
    return ps.map((p) => ({
      id: p.id as string,
      title: p.title as string,
      createdAt: p.created_at as string,
      totalPaise: Number(p.total_paise),
      children: ((kids ?? []) as Record<string, unknown>[])
        .filter((k) => k['bundle_purchase_id'] === p.id)
        .map((k) => ({
          id: k['id'] as string,
          seq: Number(k['bundle_seq']),
          title: k['title'] as string,
          status: k['status'] as string,
          totalPaise: Number(k['total_paise']),
          availableAt: (k['available_at'] as string | null) ?? null,
          dueAt: (k['due_at'] as string | null) ?? null,
          orderNumber: (k['order_number'] as string | null) ?? null,
        })),
    }))
  } catch {
    return []
  }
}

/**
 * "Cancel remaining" — every UNSTARTED child (placed / accepted) goes through
 * the ordinary buyer `cancel` transition, so the existing refund policy (100 %
 * before work starts) and processRefund (its own refund row on the shared
 * payment) apply. Started or finished children are untouched.
 */
export async function cancelRemaining(admin: Awaited<ReturnType<typeof createAdminClient>>, purchaseId: string, actor: Actor): Promise<{ cancelled: string[]; refundedPaise: number; failed: string[] }> {
  const { data: kids } = await admin.from('orders').select('id, status, bundle_seq').eq('bundle_purchase_id', purchaseId).order('bundle_seq')
  const out = { cancelled: [] as string[], refundedPaise: 0, failed: [] as string[] }
  for (const k of (kids ?? []) as { id: string; status: string }[]) {
    if (!isUnstartedChild(k.status)) continue
    const r = await applyTransition(admin, k.id, 'cancel', actor)
    if (!r.ok) { out.failed.push(k.id); continue }
    out.cancelled.push(k.id)
    const { data: rf } = await admin.from('refunds').select('amount_paise').eq('idempotency_key', `rfnd_${k.id}`).maybeSingle()
    out.refundedPaise += Number((rf as { amount_paise?: number } | null)?.amount_paise ?? 0)
  }
  return out
}
