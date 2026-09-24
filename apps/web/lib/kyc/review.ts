import 'server-only'
import { KYC_REVIEW_OUTCOMES } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Audit M12 / ADR 028 — the KYC attempts ops must look at: a vendor record that
 * is not the claimant's own business (`name_mismatch`, Udyam or penny drop) and
 * a Udyam number another account already holds (`udyam_already_claimed`). Last
 * 30 days; an item drops off once it is resolved (the bank account became
 * verified, e.g. by the audited admin override, or the account now holds the
 * Udyam claim). Service role; the admin verification queue renders it.
 */

export interface KycReviewItem {
  id: string
  kind: 'udyam' | 'bank'
  outcome: 'name_mismatch' | 'udyam_already_claimed'
  at: string
  providerId: string | null
  /** Provider display name or buyer business name; null when the account has no profile. */
  accountName: string | null
  accountKind: 'provider' | 'buyer' | null
  /** The Udyam number, or the IFSC for a bank account (never the account number). */
  subject: string
  vendorName: string | null
  reference: string | null
  reason: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

export async function getKycReviewItems(admin: Admin, opts: { sinceDays?: number; limit?: number } = {}): Promise<KycReviewItem[]> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 86400e3).toISOString()
  const limit = opts.limit ?? 50
  const [{ data: udyam }, { data: bank }] = await Promise.all([
    admin.from('udyam_verifications').select('id, user_id, udyam_number, outcome, result, created_at').in('outcome', [...KYC_REVIEW_OUTCOMES]).gte('created_at', since).order('created_at', { ascending: false }).limit(limit),
    admin.from('bank_account_verifications').select('id, user_id, ifsc, outcome, result, created_at').eq('outcome', 'name_mismatch').gte('created_at', since).order('created_at', { ascending: false }).limit(limit),
  ])
  type Row = { id: string; user_id: string; outcome: string; result: Record<string, unknown> | null; created_at: string }
  const uRows = (udyam ?? []) as (Row & { udyam_number: string })[]
  const bRows = (bank ?? []) as (Row & { ifsc: string })[]
  const userIds = [...new Set([...uRows, ...bRows].map((r) => r.user_id))]
  if (userIds.length === 0) return []

  const [{ data: provs }, { data: msmes }, { data: claims }] = await Promise.all([
    admin.from('provider_profiles').select('id, user_id, display_name').in('user_id', userIds),
    admin.from('msme_profiles').select('user_id, business_name').in('user_id', userIds),
    admin.from('udyam_verifications').select('user_id, udyam_number').in('user_id', userIds).eq('outcome', 'verified').is('released_at', null),
  ])
  const provBy = new Map(((provs ?? []) as { id: string; user_id: string; display_name: string }[]).map((p) => [p.user_id, p]))
  const msmeBy = new Map(((msmes ?? []) as { user_id: string; business_name: string }[]).map((m) => [m.user_id, m.business_name]))
  const held = new Set(((claims ?? []) as { user_id: string; udyam_number: string }[]).map((c) => `${c.user_id}|${c.udyam_number.toUpperCase()}`))
  const provIds = [...provBy.values()].map((p) => p.id)
  const { data: banks } = provIds.length ? await admin.from('provider_bank_accounts').select('provider_id, penny_drop_verified').in('provider_id', provIds) : { data: [] }
  const bankOk = new Set(((banks ?? []) as { provider_id: string; penny_drop_verified: boolean }[]).filter((b) => b.penny_drop_verified).map((b) => b.provider_id))

  const who = (userId: string) => {
    const p = provBy.get(userId)
    if (p) return { providerId: p.id, accountName: p.display_name, accountKind: 'provider' as const }
    const m = msmeBy.get(userId)
    return { providerId: null, accountName: m ?? null, accountKind: m ? ('buyer' as const) : null }
  }
  const matchOf = (r: Row) => (r.result?.['match'] ?? null) as { reference?: unknown; reason?: unknown } | null

  const items: KycReviewItem[] = []
  for (const r of uRows) {
    if (held.has(`${r.user_id}|${r.udyam_number.toUpperCase()}`)) continue
    items.push({
      id: r.id, kind: 'udyam', outcome: r.outcome as KycReviewItem['outcome'], at: r.created_at, ...who(r.user_id),
      subject: r.udyam_number, vendorName: str(r.result?.['enterpriseName']), reference: str(matchOf(r)?.reference), reason: str(matchOf(r)?.reason),
    })
  }
  for (const r of bRows) {
    const w = who(r.user_id)
    if (w.providerId && bankOk.has(w.providerId)) continue
    items.push({
      id: r.id, kind: 'bank', outcome: 'name_mismatch', at: r.created_at, ...w,
      subject: r.ifsc, vendorName: str(r.result?.['accountHolderName']), reference: str(matchOf(r)?.reference), reason: str(matchOf(r)?.reason),
    })
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}
